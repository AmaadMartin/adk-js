/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Doubles shared by the data agent tool tests: a session that records every
 * request and answers from a queue, and a clock only `sleep` advances.
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {expect} from 'vitest';
// Not part of the public entry point: these are the module's own seams, so
// they are imported from the source they live in.
import {
  DataAgentToolConfig,
  resolveDataAgentToolConfig,
} from '../../../src/tools/data_agent/config.js';
import {
  Clock,
  DataAgentToolDeps,
} from '../../../src/tools/data_agent/data_agent_tool.js';
import {
  GdaEndpointOptions,
  GdaRequest,
  GdaResponse,
  GdaSession,
  GdaSessionFactory,
} from '../../../src/tools/data_agent/gda_client.js';

/** The host the fakes answer on unless a test names another. */
export const DEFAULT_ENDPOINT = 'https://geminidataanalytics.googleapis.com';

/** How the fake session answers one request: a response, or a throw. */
export type FakeAnswer = GdaResponse | Error | (() => GdaResponse);

/** Builds a 2xx response carrying `body` as JSON. */
export function jsonResponse(body: unknown): GdaResponse {
  return {ok: true, status: 200, text: JSON.stringify(body)};
}

/** Builds a non-2xx response. */
export function errorResponse(status: number, text: string): GdaResponse {
  return {ok: false, status, text};
}

/**
 * A session that records what the tools asked for and answers from a queue.
 *
 * The queue is consumed in order and its last entry repeats, so a test that
 * configures one answer gets it for every request.
 */
export class FakeGdaSession implements GdaSession {
  /** Every request the tools issued, in order. */
  readonly requests: GdaRequest[] = [];
  /** Every chat stream the tools opened, in order. */
  readonly streams: Array<{
    url: string;
    payload: unknown;
    headers: Record<string, string>;
  }> = [];

  private answers: FakeAnswer[] = [];
  private answered = 0;
  private lines: string[] = [];
  private streamFailure?: Error;

  /** Sets what `request` answers, in order. */
  respond(...answers: FakeAnswer[]): this {
    this.answers = answers;
    this.answered = 0;
    return this;
  }

  /** Sets the lines `streamLines` yields. */
  stream(...lines: string[]): this {
    this.lines = lines;
    return this;
  }

  /** Makes `streamLines` throw instead of yielding. */
  failStream(error: Error): this {
    this.streamFailure = error;
    return this;
  }

  /** The last request the tools issued. */
  lastRequest(): GdaRequest {
    const request = this.requests.at(-1);
    if (!request) {
      return expect.fail('the tools issued no request');
    }
    return request;
  }

  async request(request: GdaRequest): Promise<GdaResponse> {
    this.requests.push(request);
    const answer =
      this.answers[Math.min(this.answered, this.answers.length - 1)];
    this.answered += 1;
    if (answer === undefined) {
      return expect.fail('the fake session was given no answer to return');
    }
    if (answer instanceof Error) {
      throw answer;
    }
    return typeof answer === 'function' ? answer() : answer;
  }

  async *streamLines(
    url: string,
    payload: unknown,
    headers: Record<string, string>,
  ): AsyncGenerator<string> {
    this.streams.push({url, payload, headers});
    if (this.streamFailure) {
      throw this.streamFailure;
    }
    yield* this.lines;
  }
}

/** A session factory that records the endpoint options each call asked for. */
export interface FakeSessionFactory {
  open: GdaSessionFactory;
  /** The endpoint options of every call, in order. */
  readonly calls: GdaEndpointOptions[];
}

/** Builds a factory that always hands back `session`. */
export function fakeSessionFactory(
  session: GdaSession,
  endpoint: string = DEFAULT_ENDPOINT,
): FakeSessionFactory {
  const calls: GdaEndpointOptions[] = [];
  return {
    calls,
    open: async (options) => {
      calls.push(options);
      return {session, endpoint};
    },
  };
}

/**
 * A monotonic clock only `sleep` advances, so a polling test that waits 60
 * seconds finishes instantly. Mirrors adk-python's `_FakeClock` fixture.
 */
export class FakeClock implements Clock {
  seconds = 0;

  now(): number {
    return this.seconds;
  }

  async sleep(seconds: number): Promise<void> {
    this.seconds += seconds;
  }
}

/** The doubles one tool call runs against. */
export interface FakeToolDeps {
  deps: DataAgentToolDeps;
  session: FakeGdaSession;
  factory: FakeSessionFactory;
  clock: FakeClock;
}

/**
 * Builds the dependencies a data agent tool call takes.
 *
 * @param config The toolset configuration under test.
 * @param endpoint The host the factory reports.
 * @return The dependencies and the doubles behind them.
 */
export function makeDeps(
  config: DataAgentToolConfig = {},
  endpoint: string = DEFAULT_ENDPOINT,
): FakeToolDeps {
  const session = new FakeGdaSession();
  const factory = fakeSessionFactory(session, endpoint);
  const clock = new FakeClock();
  return {
    session,
    factory,
    clock,
    deps: {
      openSession: factory.open,
      settings: resolveDataAgentToolConfig(config),
      clock,
    },
  };
}

/** A tool context backed by an empty session. */
export function makeToolContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'data_agent', model: 'gemini-2.5-flash'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, functionCallId: 'fc-1'});
}

/** Narrows an arbitrary value to an indexable record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads a tool result that must have succeeded. */
export function successOf(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) {
    return expect.fail(`expected a tool result, got ${String(result)}`);
  }
  expect(result['status']).toBe('SUCCESS');
  return result;
}

/** Reads the message of a tool result that must have failed. */
export function errorOf(result: unknown): string {
  if (!isRecord(result)) {
    return expect.fail(`expected a tool result, got ${String(result)}`);
  }
  expect(result['status']).toBe('ERROR');
  const details = result['error_details'];
  if (typeof details !== 'string') {
    return expect.fail(`expected error_details, got ${String(details)}`);
  }
  return details;
}
