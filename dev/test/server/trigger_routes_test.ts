/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  Logger,
  Runner,
} from '@google/adk';
import express from 'express';
import * as http from 'node:http';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {
  computeRetryDelaySeconds,
  decodeBase64Utf8,
  isTransientError,
  TriggerRouter,
  TriggerRouterOptions,
  TriggerServerContext,
} from '../../src/server/trigger_routes.js';
import {AgentFile, AgentLoader} from '../../src/utils/agent_loader.js';

const TEST_APP = 'testApp';
const BOTH_SOURCES = ['pubsub', 'eventarc'];

/** Encodes `text` the way a Pub/Sub publisher does. */
function base64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

/** One agent invocation, as observed from inside the agent. */
interface Invocation {
  userId: string;
  sessionId: string;
  text: string;
}

/** Holds an invocation open so a test can observe what overlaps it. */
type InvocationGate = (agent: RecordingAgent) => Promise<void>;

/**
 * An agent that records what each invocation received, can be primed to fail a
 * fixed number of times before it succeeds, and can be held mid-invocation.
 */
class RecordingAgent extends LlmAgent {
  readonly invocations: Invocation[] = [];
  readonly failures: unknown[] = [];
  gate?: InvocationGate;
  running = 0;
  peakConcurrency = 0;

  async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.invocations.push({
      userId: context.session.userId,
      sessionId: context.session.id,
      text: context.userContent?.parts?.[0]?.text ?? '',
    });
    this.running++;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.running);
    try {
      if (this.gate) {
        await this.gate(this);
      }
      const failure = this.failures.shift();
      if (failure !== undefined) {
        throw failure;
      }
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {role: 'model', parts: [{text: 'processed'}]},
      });
    } finally {
      this.running--;
    }
  }
}

/** An {@link AgentFile} that serves one {@link RecordingAgent} and records its disposal. */
class StubAgentFile extends AgentFile {
  wasDisposed = false;

  constructor(private readonly loaded: RecordingAgent) {
    super('trigger-routes-test-agent');
  }

  override load(): Promise<RecordingAgent> {
    return Promise.resolve(this.loaded);
  }

  override async dispose(): Promise<void> {
    this.wasDisposed = true;
  }
}

/** An {@link AgentLoader} that knows one app and rejects every other name. */
class StubAgentLoader extends AgentLoader {
  /** The file handed out by the most recent {@link getAgentFile} call. */
  lastFile?: StubAgentFile;

  constructor(private readonly gate?: InvocationGate) {
    super();
  }

  override listAgents(): Promise<string[]> {
    return Promise.resolve([TEST_APP]);
  }

  override getAgentFile(agentName: string): Promise<AgentFile> {
    if (agentName !== TEST_APP) {
      return Promise.reject(new Error(`App not found: ${agentName}`));
    }
    const agent = new RecordingAgent({
      name: 'recordingAgent',
      description: 'records what each trigger invocation received',
    });
    agent.gate = this.gate;
    this.lastFile = new StubAgentFile(agent);
    return Promise.resolve(this.lastFile);
  }
}

/** Resolves once `condition` holds, polling every millisecond. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** A logger that keeps what it was asked to write. */
class RecordingLogger implements Logger {
  readonly warnings: string[] = [];
  readonly errors: string[] = [];

  log(): void {}
  debug(): void {}
  info(): void {}
  warn(...args: unknown[]): void {
    this.warnings.push(args.map(String).join(' '));
  }
  error(...args: unknown[]): void {
    this.errors.push(args.map(String).join(' '));
  }
  setLogLevel(): void {}
}

interface HttpResult {
  status: number;
  body?: Record<string, unknown>;
}

/**
 * Posts JSON and reports the status without throwing, so a 4xx or 5xx can be
 * asserted on.
 */
async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return {status: response.status, body: JSON.parse(text)};
  } catch {
    return {status: response.status};
  }
}

interface Harness {
  url: string;
  agent: RecordingAgent;
  sessionService: InMemorySessionService;
  logger: RecordingLogger;
  close(): Promise<void>;
}

/** Binds `app` to a free loopback port. */
async function listen(
  app: express.Application,
): Promise<{url: string; close: () => Promise<void>}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    expect.fail('the test server did not bind a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/**
 * Starts a real HTTP server running a {@link TriggerRouter} over a real
 * Runner and session service, so requests exercise the whole path.
 */
async function startHarness(
  options: TriggerRouterOptions & {
    failures?: unknown[];
    gate?: InvocationGate;
  } = {},
): Promise<Harness> {
  const agent = new RecordingAgent({
    name: 'recordingAgent',
    description: 'records what each trigger invocation received',
  });
  agent.failures.push(...(options.failures ?? []));
  agent.gate = options.gate;
  const sessionService = new InMemorySessionService();
  const logger = new RecordingLogger();
  const runner = new Runner({appName: TEST_APP, agent, sessionService});
  const context: TriggerServerContext = {
    withRunner: async (appName, fn) => {
      if (appName !== TEST_APP) {
        throw new Error(`App not found: ${appName}`);
      }
      return fn(runner);
    },
    logger,
  };

  const app = express();
  app.use(express.json());
  new TriggerRouter(context, options).register(app);
  const server = await listen(app);

  return {url: server.url, agent, sessionService, logger, close: server.close};
}

/** The payload the agent received on invocation `index`. */
function payloadOf(harness: Harness, index = 0): Record<string, unknown> {
  return JSON.parse(harness.agent.invocations[index].text) as Record<
    string,
    unknown
  >;
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('Pub/Sub trigger', () => {
  it('runs the agent on the decoded message', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    const result = await post(
      `${harness.url}/apps/${TEST_APP}/trigger/pubsub`,
      {
        message: {data: base64('hello world')},
      },
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({status: 'success'});
    expect(harness.agent.invocations).toHaveLength(1);
    expect(payloadOf(harness)).toEqual({data: 'hello world', attributes: {}});
  });

  it('forwards message attributes and reports no data as null', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    const result = await post(
      `${harness.url}/apps/${TEST_APP}/trigger/pubsub`,
      {
        message: {attributes: {eventType: 'OBJECT_FINALIZE', bucket: 'b'}},
      },
    );

    expect(result.status).toBe(200);
    expect(payloadOf(harness)).toEqual({
      data: null,
      attributes: {eventType: 'OBJECT_FINALIZE', bucket: 'b'},
    });
  });

  it('parses a base64-wrapped JSON payload into an object', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(`${harness.url}/apps/${TEST_APP}/trigger/pubsub`, {
      message: {data: base64('{"orderId": 42, "items": ["a", "b"]}')},
    });

    expect(payloadOf(harness)).toEqual({
      data: {orderId: 42, items: ['a', 'b']},
      attributes: {},
    });
  });

  it('answers 400 and never runs the agent for undecodable data', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    const result = await post(
      `${harness.url}/apps/${TEST_APP}/trigger/pubsub`,
      {
        message: {data: '!!!not-valid-base64!!!'},
      },
    );

    expect(result.status).toBe(400);
    expect(result.body?.['error']).toContain('Invalid base64 message data');
    expect(harness.agent.invocations).toEqual([]);
  });

  it('answers 500 when the agent fails', async () => {
    harness = await startHarness({
      triggerSources: BOTH_SOURCES,
      failures: [new Error('Agent crashed')],
    });

    const result = await post(
      `${harness.url}/apps/${TEST_APP}/trigger/pubsub`,
      {
        message: {data: base64('hello')},
      },
    );

    expect(result.status).toBe(500);
    expect(result.body?.['error']).toBe(
      'Agent processing failed: Agent crashed',
    );
  });

  it('reports a thrown value that is not an Error', async () => {
    harness = await startHarness({
      triggerSources: BOTH_SOURCES,
      failures: ['agent rejected the payload'],
    });

    const result = await post(
      `${harness.url}/apps/${TEST_APP}/trigger/pubsub`,
      {
        message: {data: base64('hello')},
      },
    );

    expect(result.status).toBe(500);
    expect(result.body?.['error']).toBe(
      'Agent processing failed: agent rejected the payload',
    );
  });

  it('derives the user id from the subscription', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(`${harness.url}/apps/${TEST_APP}/trigger/pubsub`, {
      message: {data: base64('hello')},
      subscription: 'projects/p/subscriptions/orders-sub',
    });

    const userId = harness.agent.invocations[0].userId;
    expect(userId).toBe('projects--p--subscriptions--orders-sub');
    expect(userId).not.toContain('/');
  });

  it('falls back to pubsub-caller without a subscription', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(`${harness.url}/apps/${TEST_APP}/trigger/pubsub`, {
      message: {data: base64('hello')},
    });

    expect(harness.agent.invocations[0].userId).toBe('pubsub-caller');
  });

  it('fails an unknown app before it creates a session', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    const result = await post(`${harness.url}/apps/unknownApp/trigger/pubsub`, {
      message: {data: base64('hello')},
      subscription: 'projects/p/subscriptions/s',
    });

    expect(result.status).toBe(500);
    expect(result.body?.['error']).toContain('App not found: unknownApp');
    const sessions = await harness.sessionService.listSessions({
      appName: 'unknownApp',
      userId: 'projects--p--subscriptions--s',
    });
    expect(sessions.sessions).toEqual([]);
  });

  it('answers 422 for a body without a message', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    const result = await post(
      `${harness.url}/apps/${TEST_APP}/trigger/pubsub`,
      {
        subscription: 'projects/p/subscriptions/s',
      },
    );

    expect(result.status).toBe(422);
    expect(result.body?.['error']).toContain('Invalid Pub/Sub trigger request');
    expect(harness.agent.invocations).toEqual([]);
  });

  it('accepts a full push envelope with extra delivery fields', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    const result = await post(
      `${harness.url}/apps/${TEST_APP}/trigger/pubsub`,
      {
        message: {
          data: base64('payload'),
          attributes: {key: 'value'},
          messageId: '2070443601311540',
          publishTime: '2026-02-26T19:13:55.749Z',
          orderingKey: 'orders',
        },
        subscription: 'projects/p/subscriptions/s',
        deliveryAttempt: 2,
      },
    );

    expect(result.status).toBe(200);
    expect(payloadOf(harness)).toEqual({
      data: 'payload',
      attributes: {key: 'value'},
    });
  });

  it('creates the session the invocation ran in', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(`${harness.url}/apps/${TEST_APP}/trigger/pubsub`, {
      message: {data: base64('hello')},
      subscription: 'projects/p/subscriptions/s',
    });

    const sessions = await harness.sessionService.listSessions({
      appName: TEST_APP,
      userId: 'projects--p--subscriptions--s',
    });
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0].id).toBe(
      harness.agent.invocations[0].sessionId,
    );
  });
});

describe('Eventarc trigger', () => {
  const eventarcUrl = (base: string) =>
    `${base}/apps/${TEST_APP}/trigger/eventarc`;

  it('forwards a structured CloudEvent verbatim', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    const result = await post(eventarcUrl(harness.url), {
      id: 'event-1',
      type: 'google.cloud.storage.object.v1.finalized',
      source: '//storage.googleapis.com/projects/_/buckets/b',
      specversion: '1.0',
      data: {name: 'report.csv', size: '1024'},
    });

    expect(result.status).toBe(200);
    expect(payloadOf(harness)).toEqual({
      data: {name: 'report.csv', size: '1024'},
      attributes: {
        'ce-id': 'event-1',
        'ce-type': 'google.cloud.storage.object.v1.finalized',
        'ce-source': '//storage.googleapis.com/projects/_/buckets/b',
        'ce-specversion': '1.0',
      },
    });
  });

  it('sanitizes the user id derived from the body source', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(eventarcUrl(harness.url), {
      source: '//pubsub.googleapis.com/projects/p/topics/t',
      data: {value: 1},
    });

    expect(harness.agent.invocations[0].userId).toBe(
      'pubsub.googleapis.com--projects--p--topics--t',
    );
  });

  it('reads the source from the ce-source header when the body has none', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(
      eventarcUrl(harness.url),
      {data: {value: 1}},
      {'ce-source': '//storage.googleapis.com/buckets/b/'},
    );

    expect(harness.agent.invocations[0].userId).toBe(
      'storage.googleapis.com--buckets--b',
    );
  });

  it('falls back to eventarc-caller without a source', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(eventarcUrl(harness.url), {data: {value: 1}});

    expect(harness.agent.invocations[0].userId).toBe('eventarc-caller');
  });

  it('round-trips nested event data', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});
    const data = {
      order: {id: 7, lines: [{sku: 'a', qty: 2}], meta: {tags: ['x', 'y']}},
    };

    await post(eventarcUrl(harness.url), {id: 'e', data});

    expect(payloadOf(harness)['data']).toEqual(data);
  });

  it('answers 500 when the agent fails', async () => {
    harness = await startHarness({
      triggerSources: BOTH_SOURCES,
      failures: [new Error('Agent crashed')],
    });

    const result = await post(eventarcUrl(harness.url), {data: {value: 1}});

    expect(result.status).toBe(500);
    expect(result.body?.['error']).toBe(
      'Agent processing failed: Agent crashed',
    );
  });

  it('keeps an empty data object and emits null CloudEvent attributes', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    const result = await post(eventarcUrl(harness.url), {data: {}});

    expect(result.status).toBe(200);
    expect(payloadOf(harness)).toEqual({
      data: {},
      attributes: {
        'ce-id': null,
        'ce-type': null,
        'ce-source': null,
        'ce-specversion': null,
      },
    });
  });

  it('decodes a Pub/Sub wrapper nested in structured mode data', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(eventarcUrl(harness.url), {
      id: 'e',
      data: {
        message: {
          data: base64('{"orderId": 7}'),
          attributes: {origin: 'topic'},
        },
        subscription: 'projects/p/subscriptions/s',
      },
    });

    expect(payloadOf(harness)).toEqual({
      data: {orderId: 7},
      attributes: {origin: 'topic'},
    });
  });

  it('keeps a non-string nested wrapper payload as it arrived', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(eventarcUrl(harness.url), {
      data: {message: {data: null, attributes: {origin: 'topic'}}},
    });

    expect(payloadOf(harness)).toEqual({
      data: null,
      attributes: {origin: 'topic'},
    });
  });

  it('decodes a binary content mode Pub/Sub wrapper', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(
      eventarcUrl(harness.url),
      {
        message: {data: base64('binary mode text'), attributes: {a: '1'}},
        subscription: 'projects/p/subscriptions/s',
      },
      {'ce-source': '//pubsub.googleapis.com/projects/p/topics/t'},
    );

    expect(payloadOf(harness)).toEqual({
      data: 'binary mode text',
      attributes: {a: '1'},
    });
  });

  it('reports no data as null in binary content mode', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(eventarcUrl(harness.url), {
      message: {attributes: {a: '1'}},
    });

    expect(payloadOf(harness)).toEqual({data: null, attributes: {a: '1'}});
  });

  it('keeps undecodable wrapper data as the raw string', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    const result = await post(eventarcUrl(harness.url), {
      message: {data: '!!!not-valid-base64!!!'},
    });

    expect(result.status).toBe(200);
    expect(payloadOf(harness)).toEqual({
      data: '!!!not-valid-base64!!!',
      attributes: {},
    });
  });

  it('forwards an arbitrary body with the header CloudEvent attributes', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    const result = await post(
      eventarcUrl(harness.url),
      {customField: 'value', nested: {n: 1}},
      {
        'ce-id': 'header-id',
        'ce-type': 'custom.event',
        'ce-source': '//custom.example.com/x',
        'ce-specversion': '1.0',
      },
    );

    expect(result.status).toBe(200);
    expect(payloadOf(harness)).toEqual({
      data: {customField: 'value', nested: {n: 1}},
      attributes: {
        'ce-id': 'header-id',
        'ce-type': 'custom.event',
        'ce-source': '//custom.example.com/x',
        'ce-specversion': '1.0',
      },
    });
  });

  it('forwards only the fields the caller set', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(eventarcUrl(harness.url), {id: 'only-id'});

    expect(payloadOf(harness)['data']).toEqual({id: 'only-id'});
  });

  it('treats a null data field as absent', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    await post(eventarcUrl(harness.url), {id: 'e', data: null});

    expect(payloadOf(harness)['data']).toEqual({id: 'e', data: null});
  });

  it('answers 422 for a body that is not a CloudEvent object', async () => {
    harness = await startHarness({triggerSources: BOTH_SOURCES});

    const result = await post(eventarcUrl(harness.url), {source: 42});

    expect(result.status).toBe(422);
    expect(result.body?.['error']).toContain(
      'Invalid Eventarc trigger request',
    );
    expect(harness.agent.invocations).toEqual([]);
  });
});

describe('trigger source registration', () => {
  const paths = ['pubsub', 'eventarc'];

  async function statuses(base: string): Promise<number[]> {
    const results: number[] = [];
    for (const path of paths) {
      results.push(
        (await post(`${base}/apps/${TEST_APP}/trigger/${path}`, {message: {}}))
          .status,
      );
    }
    return results;
  }

  it('mounts nothing when no source is requested', async () => {
    harness = await startHarness();

    expect(await statuses(harness.url)).toEqual([404, 404]);
  });

  it('mounts nothing for an empty source list', async () => {
    harness = await startHarness({triggerSources: []});

    expect(await statuses(harness.url)).toEqual([404, 404]);
  });

  it('mounts only the Pub/Sub route', async () => {
    harness = await startHarness({triggerSources: ['pubsub']});

    expect(await statuses(harness.url)).toEqual([200, 404]);
  });

  it('mounts only the Eventarc route', async () => {
    harness = await startHarness({triggerSources: ['eventarc']});

    expect(await statuses(harness.url)).toEqual([404, 200]);
  });

  it('drops an unknown source and keeps the valid one', async () => {
    harness = await startHarness({
      triggerSources: ['unknown_source', 'pubsub'],
    });

    expect(await statuses(harness.url)).toEqual([200, 404]);
    expect(harness.logger.warnings).toEqual([
      'Unknown trigger source(s) ignored: unknown_source.' +
        ' Valid sources: pubsub, eventarc',
    ]);
  });

  it('mounts nothing when every source is unknown', async () => {
    harness = await startHarness({triggerSources: ['foo', 'bar']});

    expect(await statuses(harness.url)).toEqual([404, 404]);
    expect(harness.logger.warnings).toEqual([
      'Unknown trigger source(s) ignored: bar, foo.' +
        ' Valid sources: pubsub, eventarc',
    ]);
  });
});

describe('retry on transient errors', () => {
  const rateLimited = () => new Error('429 RESOURCE_EXHAUSTED: quota');

  it('retries a transient failure and reuses one session', async () => {
    harness = await startHarness({
      triggerSources: BOTH_SOURCES,
      retryBaseDelay: 0,
      failures: [rateLimited(), rateLimited()],
    });

    const result = await post(
      `${harness.url}/apps/${TEST_APP}/trigger/pubsub`,
      {
        message: {data: base64('hello')},
      },
    );

    expect(result.status).toBe(200);
    expect(harness.agent.invocations).toHaveLength(3);
    const sessionIds = new Set(
      harness.agent.invocations.map((invocation) => invocation.sessionId),
    );
    expect(sessionIds.size).toBe(1);
  });

  it('answers 500 after the Pub/Sub retries are exhausted', async () => {
    harness = await startHarness({
      triggerSources: BOTH_SOURCES,
      retryBaseDelay: 0,
      maxRetries: 2,
      failures: Array.from({length: 3}, rateLimited),
    });

    const result = await post(
      `${harness.url}/apps/${TEST_APP}/trigger/pubsub`,
      {
        message: {data: base64('hello')},
      },
    );

    expect(result.status).toBe(500);
    expect(result.body?.['error']).toContain('Rate limit exceeded (429)');
    expect(result.body?.['error']).toContain('after 3 attempts');
    expect(harness.agent.invocations).toHaveLength(3);
  });

  it('answers 500 after the Eventarc retries are exhausted', async () => {
    harness = await startHarness({
      triggerSources: BOTH_SOURCES,
      retryBaseDelay: 0,
      maxRetries: 1,
      failures: Array.from({length: 2}, rateLimited),
    });

    const result = await post(
      `${harness.url}/apps/${TEST_APP}/trigger/eventarc`,
      {data: {value: 1}},
    );

    expect(result.status).toBe(500);
    expect(result.body?.['error']).toContain('Rate limit exceeded (429)');
    expect(harness.agent.invocations).toHaveLength(2);
  });

  it('never retries a permanent failure', async () => {
    harness = await startHarness({
      triggerSources: BOTH_SOURCES,
      retryBaseDelay: 0,
      failures: [
        new Error('PERMISSION_DENIED'),
        new Error('PERMISSION_DENIED'),
      ],
    });

    const result = await post(
      `${harness.url}/apps/${TEST_APP}/trigger/pubsub`,
      {
        message: {data: base64('hello')},
      },
    );

    expect(result.status).toBe(500);
    expect(result.body?.['error']).toBe(
      'Agent processing failed: PERMISSION_DENIED',
    );
    expect(harness.agent.invocations).toHaveLength(1);
  });

  it('waits between attempts and logs each retry', async () => {
    harness = await startHarness({
      triggerSources: BOTH_SOURCES,
      retryBaseDelay: 0.01,
      retryMaxDelay: 0.01,
      maxRetries: 1,
      failures: [rateLimited()],
    });

    const result = await post(
      `${harness.url}/apps/${TEST_APP}/trigger/pubsub`,
      {
        message: {data: base64('hello')},
      },
    );

    expect(result.status).toBe(200);
    expect(harness.logger.warnings).toHaveLength(1);
    expect(harness.logger.warnings[0]).toContain(
      'Transient error (attempt 1/2)',
    );
  });
});

describe('concurrency bound', () => {
  /** Fires `count` Pub/Sub deliveries at once. */
  function burst(url: string, count: number): Promise<HttpResult[]> {
    return Promise.all(
      Array.from({length: count}, (_value, index) =>
        post(`${url}/apps/${TEST_APP}/trigger/pubsub`, {
          message: {data: base64(`message ${index}`)},
        }),
      ),
    );
  }

  it('serves both routes concurrently under a single permit', async () => {
    harness = await startHarness({
      triggerSources: BOTH_SOURCES,
      maxConcurrent: 1,
    });

    const results = await Promise.all([
      post(`${harness.url}/apps/${TEST_APP}/trigger/pubsub`, {
        message: {data: base64('one')},
      }),
      post(`${harness.url}/apps/${TEST_APP}/trigger/eventarc`, {
        data: {value: 2},
      }),
    ]);

    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(harness.agent.invocations).toHaveLength(2);
  });

  it('never runs two invocations at once under a single permit', async () => {
    harness = await startHarness({
      triggerSources: BOTH_SOURCES,
      maxConcurrent: 1,
      // Each invocation stays open long enough for the other three deliveries
      // to reach the router.
      gate: () => new Promise((resolve) => setTimeout(resolve, 20)),
    });

    const results = await burst(harness.url, 4);

    expect(results.map((result) => result.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(harness.agent.invocations).toHaveLength(4);
    expect(harness.agent.peakConcurrency).toBe(1);
  });

  it('runs up to the permit count at the same time', async () => {
    // Both invocations wait until two have run at once, so this deadlocks and
    // the test times out if the router admits them one at a time.
    harness = await startHarness({
      triggerSources: BOTH_SOURCES,
      maxConcurrent: 2,
      gate: (agent) => until(() => agent.peakConcurrency >= 2),
    });

    const results = await burst(harness.url, 2);

    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(harness.agent.peakConcurrency).toBe(2);
  });
});

describe('isTransientError', () => {
  it.each([
    ['a 429 status in the message', new Error('429 Too Many Requests')],
    ['RESOURCE_EXHAUSTED', new Error('RESOURCE_EXHAUSTED: out of tokens')],
    ['a rate limit message', new Error('Rate limit reached for model')],
    ['a quota message', new Error('Quota exceeded for requests')],
    ['a numeric status field', {status: 429}],
    ['a numeric code field', {code: 429}],
  ])('reports %s as transient', (_name, error) => {
    expect(isTransientError(error)).toBe(true);
  });

  it.each([
    ['a generic agent failure', new Error('Agent crashed')],
    ['a permission failure', new Error('PERMISSION_DENIED')],
    ['a different status', {status: 503}],
    ['a plain string', 'something went wrong'],
    ['null', null],
  ])('reports %s as permanent', (_name, error) => {
    expect(isTransientError(error)).toBe(false);
  });
});

describe('computeRetryDelaySeconds', () => {
  const noJitter = () => 0;

  it('doubles the delay on each attempt', () => {
    expect(computeRetryDelaySeconds(0, 1, 30, noJitter)).toBe(1);
    expect(computeRetryDelaySeconds(1, 1, 30, noJitter)).toBe(2);
    expect(computeRetryDelaySeconds(2, 1, 30, noJitter)).toBe(4);
  });

  it('caps the delay at the maximum', () => {
    expect(computeRetryDelaySeconds(10, 1, 30, noJitter)).toBe(30);
  });

  it('adds up to half of the delay as jitter', () => {
    expect(computeRetryDelaySeconds(1, 1, 30, () => 1)).toBe(3);
    expect(computeRetryDelaySeconds(1, 1, 30, () => 0.5)).toBe(2.5);
  });

  it('defaults to a random jitter inside the documented band', () => {
    const delay = computeRetryDelaySeconds(0, 2, 30);

    expect(delay).toBeGreaterThanOrEqual(2);
    expect(delay).toBeLessThan(3);
  });
});

describe('decodeBase64Utf8', () => {
  it('decodes a clean payload', () => {
    expect(decodeBase64Utf8(base64('hello world'))).toBe('hello world');
  });

  it('ignores characters outside the base64 alphabet', () => {
    expect(decodeBase64Utf8('SGVs bG8=')).toBe('Hello');
  });

  it('throws on incorrect padding', () => {
    expect(() => decodeBase64Utf8('!!!not-valid-base64!!!')).toThrow(
      'Incorrect padding',
    );
  });

  it('throws on bytes that are not valid UTF-8', () => {
    expect(() =>
      decodeBase64Utf8(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')),
    ).toThrow();
  });
});

describe('environment tunables', () => {
  const TUNABLES = [
    'ADK_TRIGGER_MAX_CONCURRENT',
    'ADK_TRIGGER_MAX_RETRIES',
    'ADK_TRIGGER_RETRY_BASE_DELAY',
    'ADK_TRIGGER_RETRY_MAX_DELAY',
  ];

  /** Re-imports the module so its module-level constants are re-evaluated. */
  function loadModule() {
    vi.resetModules();
    return import('../../src/server/trigger_routes.js');
  }

  function clearTunables(): void {
    for (const name of TUNABLES) {
      vi.stubEnv(name, undefined);
    }
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('falls back to the documented defaults when nothing is set', async () => {
    clearTunables();

    const module = await loadModule();

    expect(module.DEFAULT_MAX_CONCURRENT).toBe(10);
    expect(module.DEFAULT_MAX_RETRIES).toBe(3);
    expect(module.DEFAULT_RETRY_BASE_DELAY).toBe(1.0);
    expect(module.DEFAULT_RETRY_MAX_DELAY).toBe(30.0);
  });

  it('reads every tunable from the environment', async () => {
    clearTunables();
    vi.stubEnv('ADK_TRIGGER_MAX_CONCURRENT', '4');
    vi.stubEnv('ADK_TRIGGER_MAX_RETRIES', '7');
    vi.stubEnv('ADK_TRIGGER_RETRY_BASE_DELAY', '0.25');
    vi.stubEnv('ADK_TRIGGER_RETRY_MAX_DELAY', '12.5');

    const module = await loadModule();

    expect(module.DEFAULT_MAX_CONCURRENT).toBe(4);
    expect(module.DEFAULT_MAX_RETRIES).toBe(7);
    expect(module.DEFAULT_RETRY_BASE_DELAY).toBe(0.25);
    expect(module.DEFAULT_RETRY_MAX_DELAY).toBe(12.5);
  });

  it('names the variable when a value does not parse', async () => {
    clearTunables();
    vi.stubEnv('ADK_TRIGGER_RETRY_BASE_DELAY', 'soon');

    await expect(loadModule()).rejects.toThrow(
      'ADK_TRIGGER_RETRY_BASE_DELAY must be a number, got: "soon"',
    );
  });

  it('names the variable when an empty value is set', async () => {
    clearTunables();
    vi.stubEnv('ADK_TRIGGER_MAX_CONCURRENT', '');

    await expect(loadModule()).rejects.toThrow(
      'ADK_TRIGGER_MAX_CONCURRENT must be a number',
    );
  });

  it('rejects a fractional integer tunable', async () => {
    clearTunables();
    vi.stubEnv('ADK_TRIGGER_MAX_RETRIES', '2.5');

    await expect(loadModule()).rejects.toThrow(
      'ADK_TRIGGER_MAX_RETRIES must be an integer, got: 2.5',
    );
  });
});

describe('AdkApiServer trigger wiring', () => {
  let server: AdkApiServer | undefined;
  const agentLoader = new StubAgentLoader();

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('keeps the agent file alive until the invocation finishes', async () => {
    let disposedDuringRun: boolean | undefined;
    const loader: StubAgentLoader = new StubAgentLoader(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      disposedDuringRun = loader.lastFile?.wasDisposed;
    });
    server = new AdkApiServer({
      agentLoader: loader,
      triggerSources: ['pubsub'],
    });
    await server.start();

    const result = await post(`${server.url}/apps/${TEST_APP}/trigger/pubsub`, {
      message: {data: base64('hello')},
    });

    expect(result.status).toBe(200);
    expect(disposedDuringRun).toBe(false);
    expect(loader.lastFile?.wasDisposed).toBe(true);
  });

  it('mounts no trigger route by default', async () => {
    server = new AdkApiServer({agentLoader});
    await server.start();

    const result = await post(`${server.url}/apps/${TEST_APP}/trigger/pubsub`, {
      message: {data: base64('hello')},
    });

    expect(result.status).toBe(404);
  });

  it('serves an opted-in Pub/Sub trigger end to end', async () => {
    const sessionService = new InMemorySessionService();
    server = new AdkApiServer({
      agentLoader,
      sessionService,
      triggerSources: ['pubsub'],
    });
    await server.start();

    const result = await post(`${server.url}/apps/${TEST_APP}/trigger/pubsub`, {
      message: {data: base64('hello from pubsub')},
      subscription: 'projects/p/subscriptions/s',
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({status: 'success'});
    const sessions = await sessionService.listSessions({
      appName: TEST_APP,
      userId: 'projects--p--subscriptions--s',
    });
    expect(sessions.sessions).toHaveLength(1);
  });

  it('answers 500 for an app the loader cannot resolve', async () => {
    server = new AdkApiServer({agentLoader, triggerSources: ['pubsub']});
    await server.start();

    const result = await post(`${server.url}/apps/missingApp/trigger/pubsub`, {
      message: {data: base64('hello')},
    });

    expect(result.status).toBe(500);
    expect(result.body?.['error']).toContain('App not found: missingApp');
  });
});
