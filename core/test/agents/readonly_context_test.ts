/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Event,
  InvocationContext,
  InvocationContextParams,
  PluginManager,
  ReadonlyContext,
  RunConfig,
  StreamingMode,
  createSession,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

class NoopAgent extends BaseAgent {
  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

function makeContext(
  overrides: Partial<InvocationContextParams> = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation-id',
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user-id',
      state: {key1: 'value1', key2: 'value2'},
    }),
    pluginManager: new PluginManager(),
    ...overrides,
  });
}

describe('ReadonlyContext', () => {
  it('exposes the invocation id', () => {
    const context = new ReadonlyContext(makeContext());

    expect(context.invocationId).toBe('test-invocation-id');
  });

  it('exposes the name of the agent driving the invocation', () => {
    const agent = new NoopAgent({name: 'test-agent'});

    const context = new ReadonlyContext(makeContext({agent}));

    expect(context.agentName).toBe('test-agent');
  });

  it('reports the agent name as unknown when the invocation has no agent', () => {
    const context = new ReadonlyContext(makeContext());

    expect(() => context.agentName).not.toThrow();
    expect(context.agentName).toBe('unknown');
  });

  it('exposes the session state', () => {
    const context = new ReadonlyContext(makeContext());

    expect(context.state.get('key1')).toBe('value1');
    expect(context.state.get('key2')).toBe('value2');
  });

  it('exposes the user id', () => {
    const context = new ReadonlyContext(makeContext());

    expect(context.userId).toBe('test-user-id');
  });

  it('exposes the user content that started the invocation', () => {
    const userContent: Content = {role: 'user', parts: [{text: 'hello'}]};

    expect(new ReadonlyContext(makeContext({userContent})).userContent).toBe(
      userContent,
    );
    expect(new ReadonlyContext(makeContext()).userContent).toBeUndefined();
  });

  it('exposes the session id', () => {
    const context = new ReadonlyContext(makeContext());

    expect(context.sessionId).toBe('test-session');
  });

  it('exposes the request-level A2A metadata', () => {
    const a2aMetadata = {traceId: 'test-trace-id'};

    expect(new ReadonlyContext(makeContext({a2aMetadata})).a2aMetadata).toBe(
      a2aMetadata,
    );
    expect(new ReadonlyContext(makeContext()).a2aMetadata).toBeUndefined();
  });

  it('exposes the session object the invocation holds', () => {
    const invocationContext = makeContext();

    const context = new ReadonlyContext(invocationContext);

    expect(context.session).toBe(invocationContext.session);
    expect(context.session.appName).toBe('test-app');
  });

  it('exposes the run config of the invocation', () => {
    const runConfig: RunConfig = {streamingMode: StreamingMode.SSE};

    const context = new ReadonlyContext(makeContext({runConfig}));

    expect(context.runConfig).toBe(runConfig);
  });

  it('reports the run config as undefined when the invocation has none', () => {
    const context = new ReadonlyContext(makeContext());

    expect(context.runConfig).toBeUndefined();
  });
});
