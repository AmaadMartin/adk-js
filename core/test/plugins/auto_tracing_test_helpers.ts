/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Shared fixtures for the AutoTracingPlugin test files. */

import {context, type Attributes, type Tracer} from '@opentelemetry/api';
import {AsyncLocalStorageContextManager} from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {expect} from 'vitest';

import {
  AuthCredentialTypes,
  AutoTracingPlugin,
  BaseAgent,
  Event,
  InMemorySessionService,
  InvocationContext,
  PluginManager,
} from '@google/adk';

import {
  AUTO_TRACING_WRAPPED,
  DEFAULT_MAX_RECORDED_YIELDS,
  DEFAULT_MAX_REPR_LEN,
  type Caps,
} from '../../src/plugins/auto_tracing_helpers.js';

/** The default bounds, which most tests use unchanged. */
export const CAPS: Caps = {
  maxReprLen: DEFAULT_MAX_REPR_LEN,
  maxRecordedYields: DEFAULT_MAX_RECORDED_YIELDS,
};

/** A value that must never reach a span attribute. */
export const SENTINEL_TOKEN = 'sentinel-token-do-not-trace';

export const exporter = new InMemorySpanExporter();
export const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
export const tracer: Tracer = provider.getTracer('auto-tracing-test');

/**
 * Context propagation, so a span opened inside another one is parented to it.
 * Without a context manager the API's default keeps no active span and every
 * span comes out a root.
 */
export const contextManager = new AsyncLocalStorageContextManager();
context.setGlobalContextManager(contextManager.enable());

/** A plain object holding an ADK OAuth2 credential, shape for shape. */
export function sentinelCredential(): Record<string, unknown> {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {accessToken: SENTINEL_TOKEN, refreshToken: SENTINEL_TOKEN},
  };
}

export class Fixture {
  method(x: number): number {
    return x - 1;
  }

  async asyncMethod(x: number): Promise<number> {
    return x + 10;
  }
}

/** The object graph the fixture agent holds, standing in for a module. */
export function buildGraph() {
  return {
    syncFn(x: number): number {
      return x + 1;
    },
    async asyncFn(x: number): Promise<number> {
      return x * 2;
    },
    instance: new Fixture(),
  };
}

export class FixtureAgent extends BaseAgent {
  constructor(readonly graph: object) {
    super({name: 'fixture_agent', description: 'holds the traced graph'});
  }

  // eslint-disable-next-line require-yield -- BaseAgent mandates an AsyncGenerator; this fixture emits no events.
  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    return;
  }

  // eslint-disable-next-line require-yield -- BaseAgent mandates an AsyncGenerator; this fixture emits no events.
  protected async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    return;
  }
}

export async function contextFor(
  agent?: BaseAgent,
): Promise<InvocationContext> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'auto-tracing',
    userId: 'tester',
  });
  return new InvocationContext({
    invocationId: 'auto-tracing-invocation',
    agent,
    session,
    pluginManager: new PluginManager([]),
  });
}

/** Instruments a graph held by a fresh agent and returns both. */
export async function instrument<G extends object>(options: {
  graph: G;
  extraTargets?: readonly object[];
  maxRecordedYields?: number;
  maxReprLen?: number;
  maxWalkDepth?: number;
}): Promise<{
  plugin: AutoTracingPlugin;
  graph: G;
  invocationContext: InvocationContext;
}> {
  const {graph} = options;
  const plugin = new AutoTracingPlugin({
    tracer,
    extraTargets: options.extraTargets,
    maxRecordedYields: options.maxRecordedYields,
    maxReprLen: options.maxReprLen,
    maxWalkDepth: options.maxWalkDepth,
  });
  const invocationContext = await contextFor(new FixtureAgent(graph));
  await plugin.beforeRunCallback({invocationContext});
  return {plugin, graph, invocationContext};
}

export function spanNames(): string[] {
  return exporter.getFinishedSpans().map((span) => span.name);
}

/** The attributes of the one finished span named `spanName`. */
export function attributesOf(spanName: string): Attributes {
  const matches = exporter
    .getFinishedSpans()
    .filter((span) => span.name === spanName);
  expect(matches.map((span) => span.name)).toEqual([spanName]);
  return matches[0].attributes;
}

export function isWrapped(value: unknown): boolean {
  return typeof value === 'function' && AUTO_TRACING_WRAPPED in value;
}
