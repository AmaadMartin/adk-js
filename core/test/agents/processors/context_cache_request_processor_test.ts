/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveCacheMetadata,
  BaseLlm,
  BaseLlmConnection,
  CacheMetadata,
  CONTEXT_CACHE_REQUEST_PROCESSOR,
  ContextCacheConfig,
  createEvent,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const AGENT_NAME = 'test_agent';
const CURRENT_INVOCATION = 'current_invocation';
const EARLIER_INVOCATION = 'earlier_invocation';

const CACHE_CONFIG: ContextCacheConfig = {
  cacheIntervals: 10,
  ttlSeconds: 1800,
  minTokens: 1024,
};

/** A model instance, so `canonicalModel` resolves without credentials. */
class MockLlm extends BaseLlm {
  async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {}

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect is not exercised by these tests');
  }
}

function activeCacheMetadata(
  invocationsUsed = 5,
): ActiveCacheMetadata & CacheMetadata {
  return {
    cacheName: 'projects/test/locations/us-central1/cachedContents/test-cache',
    expireTime: 1800,
    fingerprint: 'test_fingerprint',
    invocationsUsed,
    contentsCount: 3,
    createdAt: 600,
  };
}

function fingerprintCacheMetadata(): CacheMetadata {
  return {fingerprint: 'test_fingerprint', contentsCount: 3};
}

function createContext(options: {
  events?: Event[];
  contextCacheConfig?: ContextCacheConfig;
}): InvocationContext {
  return new InvocationContext({
    invocationId: CURRENT_INVOCATION,
    agent: new LlmAgent({
      name: AGENT_NAME,
      model: new MockLlm({model: 'gemini-2.5-flash'}),
    }),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      events: options.events ?? [],
    }),
    pluginManager: new PluginManager([]),
    contextCacheConfig: options.contextCacheConfig,
  });
}

function emptyRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

/** Runs the processor and returns every event it yielded. */
async function run(
  invocationContext: InvocationContext,
  llmRequest: LlmRequest,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of CONTEXT_CACHE_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    events.push(event);
  }
  return events;
}

describe('ContextCacheRequestProcessor', () => {
  it('leaves the request untouched when the app configures no cache', async () => {
    const llmRequest = emptyRequest();

    const events = await run(createContext({}), llmRequest);

    expect(events).toEqual([]);
    expect(llmRequest.cacheConfig).toBeUndefined();
    expect(llmRequest.cacheMetadata).toBeUndefined();
    expect(llmRequest.cacheableContentsTokenCount).toBeUndefined();
  });

  it('reads nothing from the session when the app configures no cache', async () => {
    const llmRequest = emptyRequest();
    const events = [
      createEvent({
        author: AGENT_NAME,
        invocationId: EARLIER_INVOCATION,
        cacheMetadata: activeCacheMetadata(5),
        usageMetadata: {promptTokenCount: 250},
      }),
    ];

    await run(createContext({events}), llmRequest);

    expect(llmRequest.cacheMetadata).toBeUndefined();
    expect(llmRequest.cacheableContentsTokenCount).toBeUndefined();
  });

  it('throws when the invocation has no agent', async () => {
    const invocationContext = new InvocationContext({
      invocationId: CURRENT_INVOCATION,
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
      contextCacheConfig: CACHE_CONFIG,
    });

    await expect(run(invocationContext, emptyRequest())).rejects.toThrow(
      'InvocationContext.agent is not set',
    );
  });

  it('sets the cache config and finds no metadata in an empty session', async () => {
    const llmRequest = emptyRequest();

    const events = await run(
      createContext({contextCacheConfig: CACHE_CONFIG}),
      llmRequest,
    );

    expect(events).toEqual([]);
    expect(llmRequest.cacheConfig).toBe(CACHE_CONFIG);
    expect(llmRequest.cacheMetadata).toBeUndefined();
    expect(llmRequest.cacheableContentsTokenCount).toBeUndefined();
  });

  it('keeps the use count when the metadata comes from this invocation', async () => {
    const llmRequest = emptyRequest();
    const events = [
      createEvent({
        author: AGENT_NAME,
        invocationId: CURRENT_INVOCATION,
        cacheMetadata: activeCacheMetadata(5),
      }),
    ];

    const yielded = await run(
      createContext({events, contextCacheConfig: CACHE_CONFIG}),
      llmRequest,
    );

    expect(yielded).toEqual([]);
    expect(llmRequest.cacheMetadata).toEqual(activeCacheMetadata(5));
  });

  it('increments the use count when an active cache crosses an invocation', async () => {
    const llmRequest = emptyRequest();
    const event = createEvent({
      author: AGENT_NAME,
      invocationId: EARLIER_INVOCATION,
      cacheMetadata: activeCacheMetadata(5),
    });

    await run(
      createContext({events: [event], contextCacheConfig: CACHE_CONFIG}),
      llmRequest,
    );

    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(6);
    // The session's own event keeps its recorded count.
    expect(event.cacheMetadata?.invocationsUsed).toBe(5);
    expect(llmRequest.cacheMetadata).not.toBe(event.cacheMetadata);
  });

  it('copies fingerprint-only metadata across an invocation unchanged', async () => {
    const llmRequest = emptyRequest();
    const events = [
      createEvent({
        author: AGENT_NAME,
        invocationId: EARLIER_INVOCATION,
        cacheMetadata: fingerprintCacheMetadata(),
      }),
    ];

    await run(
      createContext({events, contextCacheConfig: CACHE_CONFIG}),
      llmRequest,
    );

    expect(llmRequest.cacheMetadata).toEqual(fingerprintCacheMetadata());
    expect(llmRequest.cacheMetadata?.invocationsUsed).toBeUndefined();
  });

  it('keeps the use count when the earlier event carries no invocation id', async () => {
    const llmRequest = emptyRequest();
    const events = [
      createEvent({
        author: AGENT_NAME,
        invocationId: '',
        cacheMetadata: activeCacheMetadata(5),
      }),
    ];

    await run(
      createContext({events, contextCacheConfig: CACHE_CONFIG}),
      llmRequest,
    );

    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(5);
  });

  it('ignores events authored by another agent', async () => {
    const llmRequest = emptyRequest();
    const events = [
      createEvent({
        author: 'other_agent',
        invocationId: EARLIER_INVOCATION,
        cacheMetadata: activeCacheMetadata(5),
        usageMetadata: {promptTokenCount: 999},
      }),
    ];

    await run(
      createContext({events, contextCacheConfig: CACHE_CONFIG}),
      llmRequest,
    );

    expect(llmRequest.cacheMetadata).toBeUndefined();
    expect(llmRequest.cacheableContentsTokenCount).toBeUndefined();
  });

  it('takes the newest prompt token count', async () => {
    const llmRequest = emptyRequest();
    const events = [
      createEvent({
        author: AGENT_NAME,
        invocationId: EARLIER_INVOCATION,
        usageMetadata: {promptTokenCount: 100},
      }),
      createEvent({
        author: AGENT_NAME,
        invocationId: EARLIER_INVOCATION,
        usageMetadata: {promptTokenCount: 250},
      }),
    ];

    await run(
      createContext({events, contextCacheConfig: CACHE_CONFIG}),
      llmRequest,
    );

    expect(llmRequest.cacheableContentsTokenCount).toBe(250);
  });

  it('finds metadata and a token count that sit on different events', async () => {
    const llmRequest = emptyRequest();
    const events = [
      createEvent({
        author: AGENT_NAME,
        invocationId: EARLIER_INVOCATION,
        cacheMetadata: activeCacheMetadata(2),
      }),
      createEvent({
        author: AGENT_NAME,
        invocationId: EARLIER_INVOCATION,
        usageMetadata: {promptTokenCount: 321},
      }),
    ];

    await run(
      createContext({events, contextCacheConfig: CACHE_CONFIG}),
      llmRequest,
    );

    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(3);
    expect(llmRequest.cacheableContentsTokenCount).toBe(321);
  });

  it('rejects active metadata that a stored session left without a use count', async () => {
    // A session read back from storage is not type-checked, so the field can
    // be missing even though the union forbids it.
    const restored: CacheMetadata = JSON.parse(
      '{"cacheName":"caches/1","expireTime":1800,"fingerprint":"fp","contentsCount":3}',
    );
    const events = [
      createEvent({
        author: AGENT_NAME,
        invocationId: EARLIER_INVOCATION,
        cacheMetadata: restored,
      }),
    ];

    await expect(
      run(
        createContext({events, contextCacheConfig: CACHE_CONFIG}),
        emptyRequest(),
      ),
    ).rejects.toThrow('Active cache metadata must include invocations_used.');
  });
});
