/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveCacheMetadata,
  CONTEXT_CACHE_REQUEST_PROCESSOR,
  ContextCacheConfig,
  createContextCacheConfig,
  createEvent,
  createSession,
  Event,
  FingerprintCacheMetadata,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

const CACHE_NAME_PREFIX = 'projects/test/locations/us-central1/cachedContents/';

function makeActiveCacheMetadata(
  overrides: Partial<ActiveCacheMetadata> = {},
): ActiveCacheMetadata {
  return {
    cacheName: `${CACHE_NAME_PREFIX}test-cache`,
    expireTime: Date.now() / 1000 + 1800,
    fingerprint: 'test_fingerprint',
    invocationsUsed: 1,
    contentsCount: 3,
    createdAt: Date.now() / 1000 - 600,
    ...overrides,
  };
}

function makeFingerprintCacheMetadata(): FingerprintCacheMetadata {
  return {fingerprint: 'test_fingerprint', contentsCount: 3};
}

function createContext(options: {
  contextCacheConfig?: ContextCacheConfig;
  events?: Event[];
  invocationId?: string;
  agentName?: string;
}): InvocationContext {
  const agent = new LlmAgent({name: options.agentName ?? 'test_agent'});
  return new InvocationContext({
    invocationId: options.invocationId ?? 'test_invocation',
    agent,
    session: createSession({
      id: 'test_session',
      appName: 'test_app',
      userId: 'test_user',
      events: options.events ?? [],
    }),
    pluginManager: new PluginManager([]),
    contextCacheConfig: options.contextCacheConfig,
  });
}

function makeLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

async function runProcessor(
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
  let cacheConfig: ContextCacheConfig;

  beforeEach(() => {
    cacheConfig = createContextCacheConfig({
      cacheIntervals: 10,
      ttlSeconds: 1800,
      minTokens: 1024,
    });
  });

  it('does nothing when there is no cache config', async () => {
    const invocationContext = createContext({});
    const llmRequest = makeLlmRequest();

    const events = await runProcessor(invocationContext, llmRequest);

    expect(events).toHaveLength(0);
    expect(llmRequest.cacheConfig).toBeUndefined();
    expect(llmRequest.cacheMetadata).toBeUndefined();
    expect(llmRequest.cacheableContentsTokenCount).toBeUndefined();
  });

  it('copies metadata as-is for the same invocation (no increment)', async () => {
    const cacheMetadata = makeActiveCacheMetadata({invocationsUsed: 5});
    const invocationContext = createContext({
      contextCacheConfig: cacheConfig,
      invocationId: 'test_invocation',
      events: [
        createEvent({
          author: 'test_agent',
          cacheMetadata,
          invocationId: 'test_invocation',
        }),
      ],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.cacheConfig).toBe(cacheConfig);
    expect(llmRequest.cacheMetadata).toEqual(cacheMetadata);
    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(5);
  });

  it('selects the most recent cache metadata', async () => {
    const newerCache = makeActiveCacheMetadata({
      invocationsUsed: 5,
      cacheName: `${CACHE_NAME_PREFIX}newer`,
    });
    const invocationContext = createContext({
      contextCacheConfig: cacheConfig,
      invocationId: 'current_invocation',
      events: [
        createEvent({
          author: 'test_agent',
          cacheMetadata: makeActiveCacheMetadata({
            invocationsUsed: 2,
            cacheName: `${CACHE_NAME_PREFIX}older`,
          }),
          invocationId: 'older_invocation',
        }),
        createEvent({
          author: 'test_agent',
          cacheMetadata: newerCache,
          invocationId: 'newer_invocation',
        }),
      ],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.cacheMetadata?.cacheName).toBe(newerCache.cacheName);
    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(6);
  });

  it('skips wrong-agent and metadata-less events, then increments', async () => {
    const cacheMetadata = makeActiveCacheMetadata({invocationsUsed: 10});
    const invocationContext = createContext({
      contextCacheConfig: cacheConfig,
      invocationId: 'current',
      events: [
        createEvent({author: 'other_agent'}),
        createEvent({author: 'test_agent'}),
        createEvent({
          author: 'test_agent',
          cacheMetadata,
          invocationId: 'prev',
        }),
        // Newest, so it is visited first: only the author filter keeps this
        // foreign agent's metadata (which would yield 10, not 11) from winning.
        createEvent({author: 'different_agent', cacheMetadata}),
      ],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.cacheConfig).toBe(cacheConfig);
    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(11);
  });

  it('extracts the previous prompt token count', async () => {
    const invocationContext = createContext({
      contextCacheConfig: cacheConfig,
      events: [
        createEvent({
          author: 'test_agent',
          usageMetadata: {
            promptTokenCount: 1024,
            candidatesTokenCount: 256,
            totalTokenCount: 1280,
          },
        }),
      ],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.cacheableContentsTokenCount).toBe(1024);
  });

  it('leaves metadata and token count unset when events carry neither', async () => {
    const invocationContext = createContext({
      contextCacheConfig: cacheConfig,
      events: [
        createEvent({author: 'test_agent', usageMetadata: {}}),
        createEvent({author: 'test_agent'}),
        createEvent({author: 'other_agent'}),
      ],
    });
    const llmRequest = makeLlmRequest();

    const events = await runProcessor(invocationContext, llmRequest);

    expect(events).toHaveLength(0);
    expect(llmRequest.cacheConfig).toBe(cacheConfig);
    expect(llmRequest.cacheMetadata).toBeUndefined();
    expect(llmRequest.cacheableContentsTokenCount).toBeUndefined();
  });

  it('selects the most recent token count, ignoring other agents', async () => {
    const invocationContext = createContext({
      contextCacheConfig: cacheConfig,
      events: [
        createEvent({
          author: 'test_agent',
          usageMetadata: {promptTokenCount: 512},
        }),
        createEvent({
          author: 'test_agent',
          usageMetadata: {promptTokenCount: 1024},
        }),
        // Newest, so it is visited first: only the author filter keeps this
        // foreign agent's token count from winning.
        createEvent({
          author: 'other_agent',
          usageMetadata: {promptTokenCount: 2048},
        }),
      ],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.cacheableContentsTokenCount).toBe(1024);
  });

  // Only test where one event supplies both values, so it is the only one that
  // reaches the scan's early exit.
  it('finds both metadata and token count in a single pass', async () => {
    const invocationContext = createContext({
      contextCacheConfig: cacheConfig,
      invocationId: 'current_invocation',
      events: [
        createEvent({
          author: 'test_agent',
          cacheMetadata: makeActiveCacheMetadata({invocationsUsed: 5}),
          usageMetadata: {promptTokenCount: 1024},
          invocationId: 'previous_invocation',
        }),
      ],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(6);
    expect(llmRequest.cacheableContentsTokenCount).toBe(1024);
  });

  it('copies fingerprint-only metadata as-is (no increment)', async () => {
    const fingerprintOnly = makeFingerprintCacheMetadata();
    const invocationContext = createContext({
      contextCacheConfig: cacheConfig,
      invocationId: 'current_invocation',
      events: [
        createEvent({
          author: 'test_agent',
          cacheMetadata: fingerprintOnly,
          invocationId: 'previous_invocation',
        }),
      ],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.cacheMetadata).toEqual(fingerprintOnly);
    expect(llmRequest.cacheMetadata?.invocationsUsed).toBeUndefined();
  });

  it('copies metadata as-is when the source event has no invocation id', async () => {
    const cacheMetadata = makeActiveCacheMetadata({invocationsUsed: 4});
    const invocationContext = createContext({
      contextCacheConfig: cacheConfig,
      invocationId: 'current_invocation',
      // No invocationId on the event -> createEvent stores '' (falsy).
      events: [createEvent({author: 'test_agent', cacheMetadata})],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(4);
  });

  it('does not mutate the source event cache metadata', async () => {
    const cacheMetadata = makeActiveCacheMetadata({invocationsUsed: 5});
    const event = createEvent({
      author: 'test_agent',
      cacheMetadata,
      invocationId: 'previous_invocation',
    });
    const invocationContext = createContext({
      contextCacheConfig: cacheConfig,
      invocationId: 'current_invocation',
      events: [event],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(invocationContext, llmRequest);

    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(6);
    expect(cacheMetadata.invocationsUsed).toBe(5);
    expect(event.cacheMetadata?.invocationsUsed).toBe(5);
  });
});
