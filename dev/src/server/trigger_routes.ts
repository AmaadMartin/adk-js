/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Trigger endpoints for event-driven agent invocations.
 *
 * Registers `/apps/:appName/trigger/pubsub` and
 * `/apps/:appName/trigger/eventarc`, which let an agent process a Pub/Sub push
 * message or an Eventarc CloudEvent without a pre-created session. A semaphore
 * keeps concurrent agent invocations inside the model quota, and transient
 * rate-limit failures are retried with exponential backoff before the handler
 * answers 500 and lets the event source redeliver.
 */

import {Logger, Runner} from '@google/adk';
import {createUserContent} from '@google/genai';
import {Application, Request, Response} from 'express';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

import {Semaphore} from '../utils/semaphore.js';

/** Trigger sources this router knows how to serve. */
export const VALID_TRIGGER_SOURCES = ['pubsub', 'eventarc'] as const;

/** One of {@link VALID_TRIGGER_SOURCES}. */
export type TriggerSource = (typeof VALID_TRIGGER_SOURCES)[number];

/**
 * Trigger sources registered when none are requested. Empty on purpose: the
 * endpoints accept unauthenticated work, so they require an explicit opt-in.
 */
const DEFAULT_TRIGGER_SOURCES: readonly string[] = [];

/** Maximum concurrent agent invocations across all trigger requests. */
export const DEFAULT_MAX_CONCURRENT = envInt('ADK_TRIGGER_MAX_CONCURRENT', 10);

/** Maximum retry attempts for transient (429) errors per request. */
export const DEFAULT_MAX_RETRIES = envInt('ADK_TRIGGER_MAX_RETRIES', 3);

/** Base delay in seconds for exponential backoff. */
export const DEFAULT_RETRY_BASE_DELAY = envNumber(
  'ADK_TRIGGER_RETRY_BASE_DELAY',
  1.0,
);

/** Maximum delay in seconds for exponential backoff. */
export const DEFAULT_RETRY_MAX_DELAY = envNumber(
  'ADK_TRIGGER_RETRY_MAX_DELAY',
  30.0,
);

/** Fraction of the backoff delay added as jitter. */
const JITTER_FRACTION = 0.5;

const MS_PER_SECOND = 1000;

/** HTTP status that both Google APIs and the classifier read as rate limiting. */
const TOO_MANY_REQUESTS = 429;

/** Lower-cased fragments that mark an error as a retryable rate limit. */
const TRANSIENT_ERROR_MARKERS = [
  '429',
  'resource_exhausted',
  'rate limit',
  'quota',
];

/** Characters outside the base64 alphabet, which Python's decoder discards. */
const NON_BASE64_PATTERN = /[^A-Za-z0-9+/=]/g;

/** Leading and trailing `/` runs, which Python's `str.strip('/')` removes. */
const SURROUNDING_SLASHES_PATTERN = /^\/+|\/+$/g;

/** Brands {@link TransientError} so it survives duplicate package copies. */
const TRANSIENT_ERROR_SYMBOL = Symbol.for('adk.trigger.TransientError');

/**
 * Raised when every retry of a transient (rate-limit) failure was used up. The
 * handler turns it into a 500 so the event source redelivers.
 */
export class TransientError extends Error {
  readonly [TRANSIENT_ERROR_SYMBOL] = true;

  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

/**
 * Type guard for {@link TransientError}. It reads the brand instead of using
 * `instanceof`, which reports false when two copies of this package share one
 * runtime.
 */
function isRetriesExhausted(value: unknown): value is TransientError {
  return (
    typeof value === 'object' &&
    value !== null &&
    TRANSIENT_ERROR_SYMBOL in value
  );
}

/** Inner message payload of a Pub/Sub push subscription. */
const pubSubMessageSchema = z.object({
  data: z.string().nullish(),
  attributes: z.record(z.string(), z.string()).nullish(),
  messageId: z.string().nullish(),
  publishTime: z.string().nullish(),
});

/**
 * Pub/Sub push subscription request format.
 *
 * See https://cloud.google.com/pubsub/docs/push#receive_push. Unknown envelope
 * keys such as `orderingKey` are dropped rather than rejected.
 */
const pubSubTriggerRequestSchema = z.object({
  message: pubSubMessageSchema,
  subscription: z.string().nullish(),
});

/**
 * Eventarc / CloudEvents request format, in either delivery mode.
 *
 * In structured content mode the CloudEvents attributes and the event data are
 * all in the JSON body. In binary content mode (the Eventarc default) the
 * attributes arrive as `ce-*` headers and the body holds only the event data,
 * typically a Pub/Sub message wrapper. Unknown keys are kept, because the
 * fallback branch forwards the body as the agent's payload.
 *
 * See https://cloud.google.com/eventarc/docs/cloudevents.
 */
const eventarcTriggerRequestSchema = z.looseObject({
  data: z.record(z.string(), z.unknown()).nullish(),
  source: z.string().nullish(),
  type: z.string().nullish(),
  id: z.string().nullish(),
  time: z.string().nullish(),
  specversion: z.string().nullish(),
  message: pubSubMessageSchema.nullish(),
  subscription: z.string().nullish(),
});

type EventarcTriggerRequest = z.infer<typeof eventarcTriggerRequestSchema>;

/** How the router reaches the agent runtime that hosts it. */
export interface TriggerServerContext {
  /**
   * Resolves the Runner for `appName` and keeps the loaded agent file alive
   * for the duration of `fn`: the loader unlinks the compiled file when the
   * scope exits, so the runner must not outlive it. Rejects for an unknown
   * app.
   */
  withRunner<T>(
    appName: string,
    fn: (runner: Runner) => Promise<T>,
  ): Promise<T>;
  logger: Logger;
}

/** Tunables of a {@link TriggerRouter}. */
export interface TriggerRouterOptions {
  /** Sources to register. Unknown entries are dropped with a warning. */
  triggerSources?: string[];
  maxConcurrent?: number;
  maxRetries?: number;
  /** Base backoff delay, in seconds. */
  retryBaseDelay?: number;
  /** Backoff ceiling, in seconds. */
  retryMaxDelay?: number;
}

/**
 * Reads `name` from the environment as a number, or returns `fallback` when it
 * is unset. Throws for a value that does not parse, because a silently ignored
 * value would hide a misconfigured quota bound.
 */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got: "${raw}"`);
  }
  return value;
}

/** {@link envNumber} restricted to integers. */
function envInt(name: string, fallback: number): number {
  const value = envNumber(name, fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got: ${value}`);
  }
  return value;
}

function isValidTriggerSource(value: string): value is TriggerSource {
  return (VALID_TRIGGER_SOURCES as readonly string[]).includes(value);
}

/** Narrows a value to an indexable record, or `undefined` when it is not one. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Returns the plain message of a thrown value, without an `Error:` prefix. */
function errorMessage(error: unknown): string {
  const record = asRecord(error);
  return typeof record?.['message'] === 'string'
    ? record['message']
    : String(error);
}

/**
 * Reports whether an error is a retryable rate limit, by its numeric status
 * and by its message. The status check matches the shape of a Google API
 * error; the message check catches the same failure once it has been wrapped.
 */
export function isTransientError(error: unknown): boolean {
  const record = asRecord(error);
  if (
    record?.['status'] === TOO_MANY_REQUESTS ||
    record?.['code'] === TOO_MANY_REQUESTS
  ) {
    return true;
  }
  const message = String(error).toLowerCase();
  return TRANSIENT_ERROR_MARKERS.some((marker) => message.includes(marker));
}

/**
 * Returns the delay, in seconds, before retry `attempt` (0-based): an
 * exponential backoff capped at `maxDelay`, plus up to half of it as jitter.
 */
export function computeRetryDelaySeconds(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  randomFn: () => number = Math.random,
): number {
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  return delay + randomFn() * delay * JITTER_FRACTION;
}

/**
 * Decodes base64 the way Python's `base64.b64decode(...).decode('utf-8')`
 * does, so an undecodable Pub/Sub payload is rejected rather than silently
 * mangled. Characters outside the base64 alphabet are discarded first, and
 * both incorrect padding and invalid UTF-8 throw. `Buffer.from(s, 'base64')`
 * alone throws for neither.
 */
export function decodeBase64Utf8(data: string): string {
  const normalized = data.replace(NON_BASE64_PATTERN, '');
  if (normalized.length % 4 !== 0) {
    throw new Error('Incorrect padding');
  }
  return new TextDecoder('utf-8', {fatal: true}).decode(
    Buffer.from(normalized, 'base64'),
  );
}

/** Parses `text` as JSON, keeping the raw string when it is not JSON. */
function parseJsonOrRaw(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Decodes a base64 payload, falling back to the value as received when it does
 * not decode. Used by the Eventarc handler, which forwards an opaque payload
 * rather than rejecting the delivery.
 */
function decodeOrRaw(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return parseJsonOrRaw(decodeBase64Utf8(value));
  } catch {
    return value;
  }
}

/**
 * Serializes the single text part handed to the agent. An absent payload
 * becomes `null` rather than a dropped key: `JSON.stringify` omits
 * `undefined` values, and the contract keeps `data` present.
 */
function triggerPayload(data: unknown, attributes: unknown): string {
  return JSON.stringify({data: data ?? null, attributes: attributes || {}});
}

/**
 * Collects the CloudEvents attributes from the body, falling back to the
 * `ce-*` headers. An attribute set in neither is `null` rather than absent, to
 * match the payload the Python SDK emits.
 */
function cloudEventAttributes(
  body: EventarcTriggerRequest,
  req: Request,
): Record<string, string | null> {
  return {
    'ce-id': body.id || req.get('ce-id') || null,
    'ce-type': body.type || req.get('ce-type') || null,
    'ce-source': body.source || req.get('ce-source') || null,
    'ce-specversion': body.specversion || req.get('ce-specversion') || null,
  };
}

/**
 * Builds the agent payload for an Eventarc delivery, covering the binary mode
 * Pub/Sub wrapper, a structured CloudEvent (whose data may itself wrap a
 * Pub/Sub message), and a body that carries neither.
 */
function eventarcMessageText(
  body: EventarcTriggerRequest,
  req: Request,
): string {
  if (body.message) {
    const {data, attributes} = body.message;
    return triggerPayload(data ? decodeOrRaw(data) : undefined, attributes);
  }

  if (body.data === undefined || body.data === null) {
    return triggerPayload(body, cloudEventAttributes(body, req));
  }

  const wrapped = asRecord(body.data['message']);
  if (wrapped && 'data' in wrapped) {
    return triggerPayload(decodeOrRaw(wrapped['data']), wrapped['attributes']);
  }
  return triggerPayload(body.data, cloudEventAttributes(body, req));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Registers the opt-in `/trigger/*` routes on an Express application.
 *
 * Each request runs the named agent in its own session, which the router
 * creates. Concurrency is bounded by a semaphore shared by both routes, and a
 * transient (429 / RESOURCE_EXHAUSTED) failure is retried with exponential
 * backoff and jitter.
 */
export class TriggerRouter {
  private readonly triggerSources: ReadonlySet<TriggerSource>;
  private readonly semaphore: Semaphore;
  private readonly maxRetries: number;
  private readonly retryBaseDelay: number;
  private readonly retryMaxDelay: number;

  constructor(
    private readonly context: TriggerServerContext,
    options: TriggerRouterOptions = {},
  ) {
    const requested = options.triggerSources ?? DEFAULT_TRIGGER_SOURCES;
    const unknown = [
      ...new Set(requested.filter((source) => !isValidTriggerSource(source))),
    ].sort();
    if (unknown.length > 0) {
      context.logger.warn(
        `Unknown trigger source(s) ignored: ${unknown.join(', ')}.` +
          ` Valid sources: ${VALID_TRIGGER_SOURCES.join(', ')}`,
      );
    }
    this.triggerSources = new Set(requested.filter(isValidTriggerSource));
    this.semaphore = new Semaphore(
      options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
    );
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelay = options.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY;
    this.retryMaxDelay = options.retryMaxDelay ?? DEFAULT_RETRY_MAX_DELAY;
  }

  /** Registers a route for each requested trigger source. */
  register(app: Application): void {
    if (this.triggerSources.has('pubsub')) {
      app.post('/apps/:appName/trigger/pubsub', (req, res) =>
        this.handlePubSub(req, res),
      );
    }
    if (this.triggerSources.has('eventarc')) {
      app.post('/apps/:appName/trigger/eventarc', (req, res) =>
        this.handleEventarc(req, res),
      );
    }
  }

  private async handlePubSub(req: Request, res: Response): Promise<void> {
    const parsed = pubSubTriggerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: `Invalid Pub/Sub trigger request: ${z.prettifyError(parsed.error)}`,
      });
      return;
    }
    const {message, subscription} = parsed.data;

    let dataPayload: unknown;
    if (message.data) {
      let decoded: string;
      try {
        decoded = decodeBase64Utf8(message.data);
      } catch (error: unknown) {
        this.context.logger.error(
          `Failed to decode Pub/Sub message data: ${errorMessage(error)}`,
        );
        res
          .status(400)
          .json({error: `Invalid base64 message data: ${errorMessage(error)}`});
        return;
      }
      dataPayload = parseJsonOrRaw(decoded);
    }

    this.context.logger.info(
      `Pub/Sub trigger: subscription=${subscription}, messageId=${message.messageId}`,
    );

    try {
      await this.runAgentWithRetry({
        appName: req.params['appName'],
        userId: (subscription || 'pubsub-caller').replaceAll('/', '--'),
        messageText: triggerPayload(dataPayload, message.attributes),
      });
    } catch (error: unknown) {
      this.respondToFailure(res, error, 'Pub/Sub');
      return;
    }
    res.json({status: 'success'});
  }

  private async handleEventarc(req: Request, res: Response): Promise<void> {
    const parsed = eventarcTriggerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        error: `Invalid Eventarc trigger request: ${z.prettifyError(parsed.error)}`,
      });
      return;
    }
    const body = parsed.data;

    const source = body.source || req.get('ce-source') || 'eventarc-caller';
    const userId = source
      .replace(SURROUNDING_SLASHES_PATTERN, '')
      .replaceAll('/', '--');

    this.context.logger.info(
      `Eventarc trigger: source=${userId}, type=${
        body.type || req.get('ce-type')
      }, id=${body.id || req.get('ce-id')}`,
    );

    try {
      await this.runAgentWithRetry({
        appName: req.params['appName'],
        userId,
        messageText: eventarcMessageText(body, req),
      });
    } catch (error: unknown) {
      this.respondToFailure(res, error, 'Eventarc');
      return;
    }
    res.json({status: 'success'});
  }

  /**
   * Runs the agent once, holding a semaphore permit for the whole invocation.
   * The runner is resolved before the session is created, so an unknown app
   * fails without leaving an orphan session behind.
   */
  private runAgent(params: {
    appName: string;
    userId: string;
    messageText: string;
    sessionId: string;
  }): Promise<void> {
    const {appName, userId, messageText, sessionId} = params;
    return this.semaphore.run(() =>
      this.context.withRunner(appName, async (runner) => {
        await runner.sessionService.getOrCreateSession({
          appName,
          userId,
          sessionId,
        });
        const events = runner.runAsync({
          userId,
          sessionId,
          newMessage: createUserContent(messageText),
        });
        for await (const _event of events) {
          // The response carries only a status; the agent's events reach the
          // caller through the session the invocation wrote them to.
        }
      }),
    );
  }

  /**
   * Runs the agent, retrying a transient failure with exponential backoff. One
   * session id is generated up front and reused by every attempt. A
   * non-transient failure is re-thrown at once, and exhausted retries raise
   * {@link TransientError}.
   */
  private async runAgentWithRetry(params: {
    appName: string;
    userId: string;
    messageText: string;
  }): Promise<void> {
    const sessionId = randomUUID();
    const totalAttempts = this.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.runAgent({...params, sessionId});
        return;
      } catch (error: unknown) {
        if (!isTransientError(error)) {
          throw error;
        }
        lastError = error;
        if (attempt < this.maxRetries) {
          const delay = computeRetryDelaySeconds(
            attempt,
            this.retryBaseDelay,
            this.retryMaxDelay,
          );
          this.context.logger.warn(
            `Transient error (attempt ${attempt + 1}/${totalAttempts}),` +
              ` retrying in ${delay.toFixed(1)}s: ${errorMessage(error)}`,
          );
          await sleep(delay * MS_PER_SECOND);
        } else {
          this.context.logger.error(
            `Transient error persisted after ${totalAttempts} attempts:` +
              ` ${errorMessage(error)}`,
          );
        }
      }
    }

    throw new TransientError(
      `Rate limit exceeded after ${totalAttempts} attempts: ${errorMessage(lastError)}`,
    );
  }

  /**
   * Answers 500 for a failed invocation, which tells Pub/Sub or Eventarc to
   * redeliver. Exhausted retries keep their own message so the operator can
   * tell a quota problem from an agent problem.
   */
  private respondToFailure(res: Response, error: unknown, label: string): void {
    if (isRetriesExhausted(error)) {
      this.context.logger.error(
        `${label}: transient error after retries: ${error.message}`,
      );
      res.status(500).json({
        error: `Rate limit exceeded (429). Retryable. ${error.message}`,
      });
      return;
    }
    this.context.logger.error(
      `Error processing ${label} trigger: ${errorMessage(error)}`,
    );
    res
      .status(500)
      .json({error: `Agent processing failed: ${errorMessage(error)}`});
  }
}
