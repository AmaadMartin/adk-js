/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  CacheMetadata,
  ContextCacheConfig,
  Event,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  createContextCacheConfig,
  createEvent,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {CONTEXT_CACHE_REQUEST_PROCESSOR} from '../../../src/agents/processors/context_cache_request_processor.js';

const CACHE_CONFIG: ContextCacheConfig = createContextCacheConfig({
  cacheIntervals: 10,
  ttlSeconds: 1800,
  minTokens: 1024,
});

function makeCacheMetadata(
  invocationsUsed: number,
  cacheName = 'test-cache',
): CacheMetadata {
  return {
    cacheName: `projects/test/locations/us-central1/cachedContents/${cacheName}`,
    expireTime: 1800,
    fingerprint: 'test_fingerprint',
    invocationsUsed,
    contentsCount: 3,
    createdAt: 600,
  };
}

function makeInvocationContext(
  agent: BaseAgent,
  options: {
    contextCacheConfig?: ContextCacheConfig;
    events?: Event[];
    invocationId?: string;
  } = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: options.invocationId ?? 'test_invocation',
    agent,
    session: createSession({
      id: 'test_session',
      appName: 'test_app',
      userId: 'test_user',
      events: options.events ?? [],
    }),
    pluginManager: new PluginManager(),
    contextCacheConfig: options.contextCacheConfig,
  });
}

function makeLlmRequest(): LlmRequest {
  return {
    model: 'gemini-2.5-flash',
    contents: [{role: 'user', parts: [{text: 'Hello'}]}],
    toolsDict: {},
    liveConnectConfig: {},
  };
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
  it('should do nothing when the invocation has no cache config', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}));
    const llmRequest = makeLlmRequest();

    const events = await runProcessor(context, llmRequest);

    expect(events).toHaveLength(0);
    expect(llmRequest.cacheConfig).toBeUndefined();
  });

  it('should not read the history when the invocation has no cache config', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      events: [
        createEvent({
          author: 'test_agent',
          cacheMetadata: makeCacheMetadata(5),
          usageMetadata: {promptTokenCount: 1024},
          invocationId: 'previous_invocation',
        }),
      ],
      invocationId: 'current_invocation',
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheMetadata).toBeUndefined();
    expect(llmRequest.cacheableContentsTokenCount).toBeUndefined();
  });

  it('should set the cache config when the session has no events', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
    });
    const llmRequest = makeLlmRequest();

    const events = await runProcessor(context, llmRequest);

    expect(events).toHaveLength(0);
    expect(llmRequest.cacheConfig).toBe(CACHE_CONFIG);
    expect(llmRequest.cacheMetadata).toBeUndefined();
  });

  it('should keep the use count when the event is from the same invocation', async () => {
    const cacheMetadata = makeCacheMetadata(5);
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [
        createEvent({
          author: 'test_agent',
          cacheMetadata,
          invocationId: 'test_invocation',
        }),
      ],
      invocationId: 'test_invocation',
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheConfig).toBe(CACHE_CONFIG);
    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(5);
  });

  it('should advance the use count when the event is from another invocation', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [
        createEvent({
          author: 'test_agent',
          cacheMetadata: makeCacheMetadata(5),
          invocationId: 'previous_invocation',
        }),
      ],
      invocationId: 'current_invocation',
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheConfig).toBe(CACHE_CONFIG);
    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(6);
  });

  it('should ignore cache metadata authored by another agent', async () => {
    const targetCache = makeCacheMetadata(3, 'target');
    const context = makeInvocationContext(
      new LlmAgent({name: 'target_agent'}),
      {
        contextCacheConfig: CACHE_CONFIG,
        events: [
          createEvent({
            author: 'other_agent',
            cacheMetadata: makeCacheMetadata(7, 'other'),
            invocationId: 'other_invocation',
          }),
          createEvent({
            author: 'target_agent',
            cacheMetadata: targetCache,
            invocationId: 'target_invocation',
          }),
        ],
        invocationId: 'current_invocation',
      },
    );
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheMetadata?.cacheName).toBe(targetCache.cacheName);
    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(4);
  });

  it('should ignore a newer cache metadata authored by another agent', async () => {
    const targetCache = makeCacheMetadata(3, 'target');
    const context = makeInvocationContext(
      new LlmAgent({name: 'target_agent'}),
      {
        contextCacheConfig: CACHE_CONFIG,
        events: [
          createEvent({
            author: 'target_agent',
            cacheMetadata: targetCache,
            invocationId: 'target_invocation',
          }),
          createEvent({
            author: 'other_agent',
            cacheMetadata: makeCacheMetadata(7, 'other'),
            invocationId: 'other_invocation',
          }),
        ],
        invocationId: 'current_invocation',
      },
    );
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheMetadata?.cacheName).toBe(targetCache.cacheName);
    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(4);
  });

  it('should pick the newest of two cache metadata events', async () => {
    const newerCache = makeCacheMetadata(5, 'newer');
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [
        createEvent({
          author: 'test_agent',
          cacheMetadata: makeCacheMetadata(2, 'older'),
          invocationId: 'older_invocation',
        }),
        createEvent({
          author: 'test_agent',
          cacheMetadata: newerCache,
          invocationId: 'newer_invocation',
        }),
      ],
      invocationId: 'current_invocation',
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheMetadata?.cacheName).toBe(newerCache.cacheName);
    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(6);
  });

  it('should leave the metadata unset when no event carries any', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [
        createEvent({author: 'test_agent'}),
        createEvent({author: 'other_agent'}),
      ],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheConfig).toBe(CACHE_CONFIG);
    expect(llmRequest.cacheMetadata).toBeUndefined();
  });

  it('should leave the metadata unset for an empty session', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheConfig).toBe(CACHE_CONFIG);
    expect(llmRequest.cacheMetadata).toBeUndefined();
  });

  it('should yield no events when a cache config is present', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
    });

    const events = await runProcessor(context, makeLlmRequest());

    expect(events).toHaveLength(0);
  });

  it('should find this agent\u2019s cache among mixed events', async () => {
    const cacheMetadata = makeCacheMetadata(10);
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [
        createEvent({author: 'other_agent'}),
        createEvent({author: 'test_agent'}),
        createEvent({author: 'different_agent', cacheMetadata}),
        createEvent({
          author: 'test_agent',
          cacheMetadata,
          invocationId: 'prev',
        }),
      ],
      invocationId: 'current',
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheConfig).toBe(CACHE_CONFIG);
    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(11);
  });

  it('should carry the prompt token count forward', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
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

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheableContentsTokenCount).toBe(1024);
  });

  it('should leave the token count unset without usage metadata', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [
        createEvent({author: 'test_agent'}),
        createEvent({author: 'other_agent'}),
      ],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheableContentsTokenCount).toBeUndefined();
  });

  it('should ignore a token count authored by another agent', async () => {
    const context = makeInvocationContext(
      new LlmAgent({name: 'target_agent'}),
      {
        contextCacheConfig: CACHE_CONFIG,
        events: [
          createEvent({
            author: 'other_agent',
            usageMetadata: {promptTokenCount: 2048},
          }),
          createEvent({
            author: 'target_agent',
            usageMetadata: {promptTokenCount: 1024},
          }),
        ],
      },
    );
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheableContentsTokenCount).toBe(1024);
  });

  it('should ignore a newer token count authored by another agent', async () => {
    const context = makeInvocationContext(
      new LlmAgent({name: 'target_agent'}),
      {
        contextCacheConfig: CACHE_CONFIG,
        events: [
          createEvent({
            author: 'target_agent',
            usageMetadata: {promptTokenCount: 1024},
          }),
          createEvent({
            author: 'other_agent',
            usageMetadata: {promptTokenCount: 2048},
          }),
        ],
      },
    );
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheableContentsTokenCount).toBe(1024);
  });

  it('should pick the newest token count', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [
        createEvent({
          author: 'test_agent',
          usageMetadata: {promptTokenCount: 512},
        }),
        createEvent({
          author: 'test_agent',
          usageMetadata: {promptTokenCount: 1024},
        }),
      ],
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheableContentsTokenCount).toBe(1024);
  });

  it('should take both values from a single event', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [
        createEvent({
          author: 'test_agent',
          cacheMetadata: makeCacheMetadata(5),
          usageMetadata: {promptTokenCount: 1024},
          invocationId: 'previous_invocation',
        }),
      ],
      invocationId: 'current_invocation',
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(6);
    expect(llmRequest.cacheableContentsTokenCount).toBe(1024);
  });

  it('should copy the metadata instead of sharing the event\u2019s object', async () => {
    const cacheMetadata = makeCacheMetadata(5);
    const event = createEvent({
      author: 'test_agent',
      cacheMetadata,
      invocationId: 'test_invocation',
    });
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [event],
      invocationId: 'test_invocation',
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheMetadata).toEqual(cacheMetadata);
    expect(llmRequest.cacheMetadata).not.toBe(cacheMetadata);

    if (!llmRequest.cacheMetadata) {
      expect.fail('the processor did not set cacheMetadata');
    }
    llmRequest.cacheMetadata.invocationsUsed = 99;
    expect(context.session.events[0].cacheMetadata?.invocationsUsed).toBe(5);
  });

  it('should not advance the use count for an event with an empty invocation id', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [
        createEvent({
          author: 'test_agent',
          cacheMetadata: makeCacheMetadata(5),
        }),
      ],
      invocationId: 'current_invocation',
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(5);
  });

  it('should reject an active cache from another invocation with no use count', async () => {
    // An active cache always carries a use count, but an event rehydrated
    // from storage can arrive without one.
    const rehydrated: CacheMetadata = {
      cacheName: 'projects/test/locations/us-central1/cachedContents/test',
      expireTime: 1800,
      fingerprint: 'test_fingerprint',
      contentsCount: 3,
    };
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [
        createEvent({
          author: 'test_agent',
          cacheMetadata: rehydrated,
          invocationId: 'previous_invocation',
        }),
      ],
      invocationId: 'current_invocation',
    });

    await expect(runProcessor(context, makeLlmRequest())).rejects.toThrow(
      'Active cache metadata must include invocationsUsed.',
    );
  });

  it('should take the metadata and the token count from different events', async () => {
    const context = makeInvocationContext(new LlmAgent({name: 'test_agent'}), {
      contextCacheConfig: CACHE_CONFIG,
      events: [
        createEvent({
          author: 'test_agent',
          usageMetadata: {promptTokenCount: 512},
        }),
        createEvent({
          author: 'test_agent',
          cacheMetadata: makeCacheMetadata(5),
          invocationId: 'previous_invocation',
        }),
      ],
      invocationId: 'current_invocation',
    });
    const llmRequest = makeLlmRequest();

    await runProcessor(context, llmRequest);

    expect(llmRequest.cacheMetadata?.invocationsUsed).toBe(6);
    expect(llmRequest.cacheableContentsTokenCount).toBe(512);
  });

  it('should not throw for a bare node when caching is off', async () => {
    const context = new InvocationContext({
      invocationId: 'test_invocation',
      session: createSession({
        id: 'test_session',
        appName: 'test_app',
        userId: 'test_user',
        events: [],
      }),
      pluginManager: new PluginManager(),
    });
    const llmRequest = makeLlmRequest();

    await expect(runProcessor(context, llmRequest)).resolves.toEqual([]);
    expect(llmRequest.cacheConfig).toBeUndefined();
  });

  it('should throw when the invocation runs a node rather than an agent', async () => {
    const context = new InvocationContext({
      invocationId: 'test_invocation',
      session: createSession({
        id: 'test_session',
        appName: 'test_app',
        userId: 'test_user',
        events: [],
      }),
      pluginManager: new PluginManager(),
      contextCacheConfig: CACHE_CONFIG,
    });

    await expect(runProcessor(context, makeLlmRequest())).rejects.toThrow(
      'InvocationContext.agent is not set',
    );
  });
});
