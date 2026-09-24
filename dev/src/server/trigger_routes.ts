/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Trigger endpoints for event-driven agent invocations.
 *
 * Ported from adk-python `src/google/adk/cli/trigger_routes.py`.
 *
 * The `/trigger/pubsub` and `/trigger/eventarc` endpoints let an agent process
 * a Pub/Sub push message or an Eventarc CloudEvent without a pre-created
 * session. A semaphore bounds concurrent agent invocations so a burst of
 * deliveries stays inside the model's quota, and a transient rate-limit
 * failure is retried with exponential backoff before the delivery is failed
 * back to the calling service.
 *
 * See https://cloud.google.com/pubsub/docs/push#receive_push and
 * https://cloud.google.com/eventarc/docs/cloudevents.
 */

import {getLogger, Logger, Runner} from '@google/adk';
import {createUserContent} from '@google/genai';
import {
  Application,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';
import {OAuth2Client} from 'google-auth-library';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

import {decodeBase64Utf8, parseJsonOrRaw} from '../utils/base64_utils.js';
import {asRecord, errorMessage, errorName} from '../utils/error_utils.js';
import {Semaphore} from '../utils/semaphore.js';

const logger = getLogger();

/** The trigger sources this router knows how to serve. */
export const VALID_TRIGGER_SOURCES = ['pubsub', 'eventarc'] as const;

/** A trigger source named by the operator. */
export type TriggerSource = (typeof VALID_TRIGGER_SOURCES)[number];

/** Environment variable bounding concurrent agent invocations. */
export const TRIGGER_MAX_CONCURRENT_ENV_VAR = 'ADK_TRIGGER_MAX_CONCURRENT';
/** Environment variable bounding retries of a transient failure. */
export const TRIGGER_MAX_RETRIES_ENV_VAR = 'ADK_TRIGGER_MAX_RETRIES';
/** Environment variable holding the backoff base delay, in seconds. */
export const TRIGGER_RETRY_BASE_DELAY_ENV_VAR = 'ADK_TRIGGER_RETRY_BASE_DELAY';
/** Environment variable capping the backoff delay, in seconds. */
export const TRIGGER_RETRY_MAX_DELAY_ENV_VAR = 'ADK_TRIGGER_RETRY_MAX_DELAY';

const DEFAULT_MAX_CONCURRENT = 10;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_SECONDS = 1;
const DEFAULT_RETRY_MAX_DELAY_SECONDS = 30;

const PUBSUB_DEFAULT_USER_ID = 'pubsub-caller';
const EVENTARC_DEFAULT_USER_ID = 'eventarc-caller';

const MILLISECONDS_PER_SECOND = 1000;
/** Fraction of the backoff delay added as random jitter. */
const RETRY_JITTER_RATIO = 0.5;

const TOO_MANY_REQUESTS_STATUS = 429;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;

/** Lowercased substrings that mark a failure as a transient rate limit. */
const TRANSIENT_ERROR_SUBSTRINGS = [
  '429',
  'resource_exhausted',
  'rate limit',
  'quota',
];

/**
 * `Bearer <token>`, matched case-insensitively. Only a space separates the two,
 * as in the reference's `partition(" ")`, and the token must be non-empty once
 * trimmed.
 */
const BEARER_TOKEN_PATTERN = /^bearer +(.+)$/i;

/** The CloudEvents attributes Eventarc sends as `ce-*` request headers. */
const CLOUD_EVENT_ATTRIBUTES = ['id', 'type', 'source', 'specversion'] as const;

/**
 * Reads a numeric setting from the environment, falling back to `fallback`
 * when the variable is unset, empty or not a number.
 */
function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Raised when every retry of a transient failure was exhausted. */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

/** Raised by a verifier to reject a request with a specific HTTP status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Reports whether `error` is an {@link HttpError}. Matched by name rather than
 * by `instanceof` so that a verifier built against a second copy of this
 * package in the same runtime still selects its own status.
 */
function isHttpError(error: unknown): error is HttpError {
  return (
    error instanceof Error &&
    error.name === 'HttpError' &&
    'status' in error &&
    typeof error.status === 'number'
  );
}

/**
 * Reports whether `error` is a transient rate-limit failure worth retrying.
 *
 * A numeric `status` or `code` of 429 is recognised structurally; otherwise
 * the message is matched against the same substrings the reference uses.
 */
export function isTransientError(error: unknown): boolean {
  const record = asRecord(error);
  if (
    record?.['status'] === TOO_MANY_REQUESTS_STATUS ||
    record?.['code'] === TOO_MANY_REQUESTS_STATUS
  ) {
    return true;
  }
  const message = errorMessage(error).toLowerCase();
  return TRANSIENT_ERROR_SUBSTRINGS.some((needle) => message.includes(needle));
}

const pubSubMessageSchema = z.object({
  data: z.string().nullish(),
  attributes: z.record(z.string(), z.string()).nullish(),
  messageId: z.string().nullish(),
  publishTime: z.string().nullish(),
});

/** A Pub/Sub push subscription delivery. */
const pubSubTriggerRequestSchema = z.object({
  message: pubSubMessageSchema,
  subscription: z.string().nullish(),
});

/**
 * A CloudEvent delivered by Eventarc, in either content mode. Unknown keys are
 * kept because the fallback branch forwards the whole body as the payload.
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

/** The `{data, attributes}` object serialized into the agent's message. */
interface TriggerPayload {
  data: unknown;
  attributes: Record<string, unknown>;
}

/**
 * Normalizes trigger metadata into a session-safe user id: whitespace and
 * surrounding slashes are removed, remaining slashes become `--`, and an empty
 * result falls back to `fallback`.
 */
function makeTriggerUserId(
  rawValue: string | null | undefined,
  fallback: string,
): string {
  if (!rawValue) {
    return fallback;
  }
  const normalized = rawValue.trim().replace(/^\/+|\/+$/g, '');
  return normalized ? normalized.replaceAll('/', '--') : fallback;
}

/**
 * Decodes a base64 payload and parses it as JSON, keeping the decoded text
 * when it is not JSON. Throws when the payload is not decodable.
 */
function decodeTriggerData(encoded: string): unknown {
  return parseJsonOrRaw(decodeBase64Utf8(encoded));
}

/**
 * Decodes a payload the Eventarc endpoint received, forwarding the value
 * unchanged when it is not decodable. This endpoint never fails a delivery on
 * a decode error; only the Pub/Sub endpoint answers 400.
 */
function decodeTriggerDataOrRaw(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? null;
  }
  try {
    return decodeTriggerData(value);
  } catch {
    return value;
  }
}

/** Reads the four CloudEvents attributes from the body, then the headers. */
function cloudEventAttributes(
  req: Request,
  body: EventarcTriggerRequest,
): Record<string, string | null> {
  const attributes: Record<string, string | null> = {};
  for (const name of CLOUD_EVENT_ATTRIBUTES) {
    attributes[`ce-${name}`] = body[name] || req.get(`ce-${name}`) || null;
  }
  return attributes;
}

/**
 * Returns the Pub/Sub message wrapped inside an Eventarc `data` object, or
 * `undefined` when `data` does not wrap one. The `data` key must be present,
 * even when its value is null, exactly as the reference requires.
 */
function wrappedPubSubMessage(
  data: unknown,
): Record<string, unknown> | undefined {
  const message = asRecord(asRecord(data)?.['message']);
  return message && 'data' in message ? message : undefined;
}

/**
 * Builds the payload the Eventarc endpoint sends to the agent, in the same
 * branch order as the reference: a Pub/Sub wrapper in the body, then a
 * structured `data` object, then the whole body.
 */
function buildEventarcPayload(
  req: Request,
  body: EventarcTriggerRequest,
): TriggerPayload {
  if (body.message) {
    return {
      data: body.message.data
        ? decodeTriggerDataOrRaw(body.message.data)
        : null,
      attributes: body.message.attributes ?? {},
    };
  }

  if (body.data !== undefined && body.data !== null) {
    const wrapped = wrappedPubSubMessage(body.data);
    if (wrapped) {
      return {
        data: decodeTriggerDataOrRaw(wrapped['data']),
        attributes: asRecord(wrapped['attributes']) ?? {},
      };
    }
    return {data: body.data, attributes: cloudEventAttributes(req, body)};
  }

  // The body holds precisely the keys the caller sent, which is what the
  // reference's `model_dump(exclude_unset=True)` produces.
  return {data: req.body, attributes: cloudEventAttributes(req, body)};
}

/** Runs a verifier before the trigger handler; throwing rejects the request. */
export type TriggerVerifier = (req: Request) => void | Promise<void>;

/**
 * Verifies the Google OIDC bearer token on a trigger request.
 *
 * Cloud Run and Eventarc sign push deliveries with an identity token whose
 * audience is the receiving service. One `OAuth2Client` is created per
 * verifier and reused, so Google's signing certificates are fetched once
 * rather than per request.
 */
export class GoogleOidcVerifier {
  private readonly client = new OAuth2Client();

  /**
   * @param audience The audience the identity token must carry, normally the
   *   receiving service's URL.
   * @param allowedEmails Service account addresses allowed to call. When
   *   empty or omitted, any token valid for `audience` is accepted.
   */
  constructor(
    private readonly audience: string,
    private readonly allowedEmails?: string[],
  ) {}

  /** Rejects with an {@link HttpError} when the request is not authorized. */
  async verify(req: Request): Promise<void> {
    const token = BEARER_TOKEN_PATTERN.exec(
      req.get('authorization') ?? '',
    )?.[1].trim();
    if (!token) {
      throw new HttpError(
        UNAUTHORIZED_STATUS,
        'Missing or malformed Authorization bearer token.',
      );
    }

    try {
      const ticket = await this.client.verifyIdToken({
        idToken: token,
        audience: this.audience,
      });
      if (this.allowedEmails?.length) {
        const payload = ticket.getPayload();
        const trusted =
          payload?.email_verified === true &&
          payload.email !== undefined &&
          this.allowedEmails.includes(payload.email);
        if (!trusted) {
          throw new HttpError(FORBIDDEN_STATUS, 'Untrusted token principal.');
        }
      }
    } catch (error: unknown) {
      if (isHttpError(error)) {
        throw error;
      }
      // Only the error's class name is logged. google-auth-library builds the
      // raw token into "Wrong number of segments in token: <jwt>" and the
      // decoded claims into "Token used too late, ... <payload>", so logging
      // the message would write the caller's credential and principal to disk.
      logger.warn(`OIDC token verification failed (${errorName(error)}).`);
      throw new HttpError(
        UNAUTHORIZED_STATUS,
        'OIDC token verification failed.',
      );
    }
  }
}

/**
 * The runtime the trigger routes invoke. Implemented by the API server, which
 * keeps its runner cache, agent loader and session service private.
 */
export interface TriggerServerContext {
  /**
   * Resolves the `Runner` for `appName` and keeps the loaded agent file alive
   * for the whole of `fn`. Rejects for an unknown app.
   */
  withRunner<T>(
    appName: string,
    fn: (runner: Runner) => Promise<T>,
  ): Promise<T>;
  logger: Logger;
}

/** Options for {@link TriggerRouter}. */
export interface TriggerRouterOptions {
  /**
   * Sources to serve. Nothing is mounted when omitted or empty, so a trigger
   * endpoint only exists once the operator asks for it by name. Unknown names
   * are ignored with a warning.
   */
  triggerSources?: string[];
  /**
   * Runs before the handler; throwing rejects the request. Without one the
   * trigger endpoints accept unauthenticated work, so the deployment platform
   * has to control access.
   */
  verifier?: TriggerVerifier;
}

/**
 * Registers the opt-in `/apps/:appName/trigger/*` routes on an Express app.
 *
 * Each delivery creates an ephemeral session, runs the agent to completion and
 * answers `{"status": "success"}`. A failure answers 5xx so the calling
 * service redelivers.
 */
export class TriggerRouter {
  private readonly triggerSources: TriggerSource[];
  private readonly semaphore: Semaphore;
  private readonly maxRetries: number;
  private readonly retryBaseDelay: number;
  private readonly retryMaxDelay: number;
  private readonly verifier?: TriggerVerifier;
  private readonly logger: Logger;

  constructor(
    private readonly context: TriggerServerContext,
    options: TriggerRouterOptions = {},
  ) {
    this.logger = context.logger;
    this.verifier = options.verifier;
    this.triggerSources = resolveTriggerSources(
      options.triggerSources ?? [],
      this.logger,
    );
    this.semaphore = new Semaphore(
      numberFromEnv(TRIGGER_MAX_CONCURRENT_ENV_VAR, DEFAULT_MAX_CONCURRENT),
    );
    this.maxRetries = numberFromEnv(
      TRIGGER_MAX_RETRIES_ENV_VAR,
      DEFAULT_MAX_RETRIES,
    );
    this.retryBaseDelay = numberFromEnv(
      TRIGGER_RETRY_BASE_DELAY_ENV_VAR,
      DEFAULT_RETRY_BASE_DELAY_SECONDS,
    );
    this.retryMaxDelay = numberFromEnv(
      TRIGGER_RETRY_MAX_DELAY_ENV_VAR,
      DEFAULT_RETRY_MAX_DELAY_SECONDS,
    );
  }

  /** Registers a route for each enabled trigger source. */
  register(app: Application): void {
    // The verifier is per-route middleware rather than a step inside the
    // handler, so an unauthenticated request is rejected before its body is
    // validated and answers 401/403 instead of 422.
    const guards: RequestHandler[] = this.verifier
      ? [buildVerifyMiddleware(this.verifier, this.logger)]
      : [];

    if (this.triggerSources.includes('pubsub')) {
      app.post(
        '/apps/:appName/trigger/pubsub',
        ...guards,
        async (req: Request, res: Response) => {
          await this.handlePubSub(req, res);
        },
      );
    }

    if (this.triggerSources.includes('eventarc')) {
      app.post(
        '/apps/:appName/trigger/eventarc',
        ...guards,
        async (req: Request, res: Response) => {
          await this.handleEventarc(req, res);
        },
      );
    }
  }

  private async handlePubSub(req: Request, res: Response): Promise<void> {
    const parsed = pubSubTriggerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(422)
        .json({error: `Invalid Pub/Sub push body: ${parsed.error.message}`});
      return;
    }

    const {message, subscription} = parsed.data;
    let data: unknown = null;
    if (message.data) {
      try {
        data = decodeTriggerData(message.data);
      } catch (error: unknown) {
        const detail = errorMessage(error);
        this.logger.error(`Failed to decode Pub/Sub message data: ${detail}`);
        res.status(400).json({error: `Invalid base64 message data: ${detail}`});
        return;
      }
    }

    this.logger.debug(
      `Pub/Sub trigger: subscription=${subscription}, ` +
        `messageId=${message.messageId}`,
    );

    await this.runTrigger(
      req,
      res,
      makeTriggerUserId(subscription, PUBSUB_DEFAULT_USER_ID),
      {data, attributes: message.attributes ?? {}},
    );
  }

  private async handleEventarc(req: Request, res: Response): Promise<void> {
    const parsed = eventarcTriggerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(422)
        .json({error: `Invalid CloudEvent body: ${parsed.error.message}`});
      return;
    }

    const body = parsed.data;
    const userId = makeTriggerUserId(
      body.source || req.get('ce-source'),
      EVENTARC_DEFAULT_USER_ID,
    );

    this.logger.debug(
      `Eventarc trigger: source=${userId}, ` +
        `type=${body.type || req.get('ce-type')}, ` +
        `id=${body.id || req.get('ce-id')}`,
    );

    await this.runTrigger(req, res, userId, buildEventarcPayload(req, body));
  }

  /**
   * Runs the agent for one delivery and writes the response. Shared by both
   * endpoints so their status codes cannot drift apart.
   */
  private async runTrigger(
    req: Request,
    res: Response,
    userId: string,
    payload: TriggerPayload,
  ): Promise<void> {
    try {
      await this.runAgentWithRetry(
        req.params['appName'],
        userId,
        JSON.stringify(payload),
      );
      res.status(200).json({status: 'success'});
    } catch (error: unknown) {
      const message = errorMessage(error);
      // `TransientError` is thrown and caught inside this module only, so a
      // duplicated copy of this package cannot supply the value seen here.
      if (error instanceof TransientError) {
        this.logger.error(`Trigger: transient error after retries: ${message}`);
        res
          .status(500)
          .json({error: `Rate limit exceeded (429). Retryable. ${message}`});
        return;
      }
      this.logger.error(`Error processing trigger delivery: ${message}`);
      res.status(500).json({error: `Agent processing failed: ${message}`});
    }
  }

  /**
   * Runs the agent, retrying a transient failure with exponential backoff and
   * jitter. A non-transient failure is rethrown immediately.
   *
   * The session id is generated once and reused by every attempt, so a retry
   * continues the same ephemeral session rather than starting a new one.
   */
  private async runAgentWithRetry(
    appName: string,
    userId: string,
    messageText: string,
  ): Promise<void> {
    const sessionId = randomUUID();
    const attempts = this.maxRetries + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await this.runAgent(appName, userId, messageText, sessionId);
        return;
      } catch (error: unknown) {
        if (!isTransientError(error)) {
          throw error;
        }
        lastError = error;
        if (attempt === this.maxRetries) {
          break;
        }
        const delay = Math.min(
          this.retryBaseDelay * 2 ** attempt,
          this.retryMaxDelay,
        );
        const totalDelay = delay + Math.random() * delay * RETRY_JITTER_RATIO;
        this.logger.warn(
          `Transient error (attempt ${attempt + 1}/${attempts}), retrying in ` +
            `${totalDelay.toFixed(1)}s: ${errorMessage(error)}`,
        );
        await new Promise<void>((resolve) => {
          setTimeout(resolve, totalDelay * MILLISECONDS_PER_SECOND);
        });
      }
    }

    throw new TransientError(
      `Rate limit exceeded after ${attempts} attempts: ` +
        errorMessage(lastError),
    );
  }

  /**
   * Runs the agent once in an ephemeral session, holding a semaphore permit
   * for the whole invocation.
   *
   * The runner is resolved before the session is created, so an unknown app
   * fails without leaving an orphan session behind.
   */
  private runAgent(
    appName: string,
    userId: string,
    messageText: string,
    sessionId: string,
  ): Promise<void> {
    return this.semaphore.run(() =>
      this.context.withRunner(appName, async (runner) => {
        const session = await runner.sessionService.getOrCreateSession({
          appName,
          userId,
          sessionId,
        });
        for await (const _event of runner.runAsync({
          userId,
          sessionId: session.id,
          newMessage: createUserContent(messageText),
        })) {
          // The response carries only the delivery status, so the agent's
          // events are drained and discarded.
        }
      }),
    );
  }
}

/** Drops unknown trigger source names, warning about each one. */
function resolveTriggerSources(
  requested: string[],
  log: Logger,
): TriggerSource[] {
  const isValid = (name: string): name is TriggerSource =>
    (VALID_TRIGGER_SOURCES as readonly string[]).includes(name);
  const unknown = [...new Set(requested.filter((name) => !isValid(name)))];
  if (unknown.length > 0) {
    log.warn(
      `Unknown trigger source(s) ignored: ${unknown.sort().join(', ')}. ` +
        `Valid sources: ${VALID_TRIGGER_SOURCES.join(', ')}`,
    );
  }
  return requested.filter(isValid);
}

/**
 * Wraps a verifier as Express middleware. A rejection carrying an
 * {@link HttpError} answers that status; anything else is a server fault and
 * answers 500. Either way the handler never runs.
 */
function buildVerifyMiddleware(
  verify: TriggerVerifier,
  log: Logger,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await verify(req);
      next();
    } catch (error: unknown) {
      const status = isHttpError(error) ? error.status : 500;
      const message = errorMessage(error);
      log.warn(`Trigger request rejected with ${status}: ${message}`);
      res.status(status).json({error: message});
    }
  };
}
