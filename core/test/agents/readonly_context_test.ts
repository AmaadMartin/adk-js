/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  BaseAgent,
  Context,
  Event,
  InvocationContext,
  InvocationContextParams,
  PluginManager,
  ReadonlyContext,
  ReadonlyState,
  ReadonlyStateError,
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

  it('starts the custom metadata of a new invocation empty', () => {
    const context = new ReadonlyContext(makeContext());

    expect(context.customMetadata).toEqual({});
  });

  it('exposes metadata written into the invocation', () => {
    const invocationContext = makeContext();
    const context = new ReadonlyContext(invocationContext);

    invocationContext.customMetadata['source'] = 'test-tool';

    expect(context.customMetadata).toEqual({source: 'test-tool'});
  });

  it('exposes a credential resolved for this invocation', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test-api-key',
    };

    const context = new ReadonlyContext(
      makeContext({credentialByKey: {'my-key': credential}}),
    );

    expect(context.getCredential('my-key')).toBe(credential);
  });

  it('reports an unresolved credential key as undefined', () => {
    const context = new ReadonlyContext(makeContext());

    expect(context.getCredential('missing-key')).toBeUndefined();
  });

  it('reports an inherited object key as an unresolved credential', () => {
    const context = new ReadonlyContext(makeContext());

    expect(context.getCredential('toString')).toBeUndefined();
    expect(context.getCredential('constructor')).toBeUndefined();
    expect(context.getCredential('__proto__')).toBeUndefined();
  });

  it('reports an inherited object key as unresolved when the caller supplied the map', () => {
    const context = new ReadonlyContext(makeContext({credentialByKey: {}}));

    expect(context.getCredential('toString')).toBeUndefined();
    expect(context.getCredential('constructor')).toBeUndefined();
    expect(context.getCredential('__proto__')).toBeUndefined();
  });

  it('sees credentials resolved after the readonly context was created', () => {
    const invocationContext = makeContext();
    const context = new ReadonlyContext(invocationContext);
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test-api-key',
    };

    invocationContext.credentialByKey['late-key'] = credential;

    expect(context.getCredential('late-key')).toBe(credential);
  });
});

describe('ReadonlyContext.state as a read-only view', () => {
  it('rejects a write and leaves the session state unchanged', () => {
    const invocationContext = makeContext();
    const view = new ReadonlyContext(invocationContext).state;

    // The declared view type hides `set`; a JavaScript caller still reaches
    // it, which is the write this narrowing exercises.
    if (!(view instanceof ReadonlyState)) {
      expect.fail('ReadonlyContext.state did not return a read-only view');
    }

    expect(() => view.set('key1', 'hacked')).toThrow(ReadonlyStateError);
    expect(invocationContext.session.state['key1']).toBe('value1');
  });

  it('rejects an update and leaves the session state unchanged', () => {
    const invocationContext = makeContext();
    const view = new ReadonlyContext(invocationContext).state;

    if (!(view instanceof ReadonlyState)) {
      expect.fail('ReadonlyContext.state did not return a read-only view');
    }

    expect(() => view.update({key1: 'hacked'})).toThrow(ReadonlyStateError);
    expect(invocationContext.session.state['key1']).toBe('value1');
  });

  it('reads a value a Context wrote after the view was taken', () => {
    const invocationContext = makeContext();
    const view = new ReadonlyContext(invocationContext).state;
    const writer = new Context({invocationContext});

    writer.state.set('key1', 'written');
    writer.state.set('key3', 'value3');

    expect(view.get('key1')).toBe('written');
    expect(view.get('key3')).toBe('value3');
  });

  it('hands out a view that reads the session state as a record', () => {
    const context = new ReadonlyContext(makeContext());

    expect(context.state.toRecord()).toEqual({
      key1: 'value1',
      key2: 'value2',
    });
    expect(context.state.has('key1')).toBe(true);
    expect(context.state.has('missing')).toBe(false);
  });
});
