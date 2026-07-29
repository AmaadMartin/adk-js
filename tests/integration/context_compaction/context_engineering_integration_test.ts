/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Agent,
  createContextCacheConfig,
  InMemoryRunner,
  LlmRequest,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

const TURN_1_CACHE_METADATA = {
  cacheName: 'projects/123/locations/us-central1/cachedContents/test_cache_001',
  expireTime: 1700000000,
  fingerprint: 'hash_abc123',
  invocationsUsed: 1,
  contentsCount: 12,
};

describe('Context Engineering Integration', () => {
  it('should enable context caching and resolve cache metadata and token counts across multiple turns', async () => {
    const capturedRequests: LlmRequest[] = [];
    let modelResponseCount = 0;

    const agent = new Agent({
      name: 'caching-agent',
      instruction: 'You are a helpful caching assistant.',
      contextCacheConfig: createContextCacheConfig({
        ttlSeconds: 1800,
        minTokens: 4096,
      }),
      beforeModelCallback: ({request}) => {
        capturedRequests.push({
          ...request,
          cacheConfig: request.cacheConfig
            ? {...request.cacheConfig}
            : undefined,
          cacheMetadata: request.cacheMetadata
            ? {...request.cacheMetadata}
            : undefined,
          contents: [...request.contents],
        });
        return undefined;
      },
      // Stands in for the cache manager that will stamp metadata onto the
      // model response. Attaching it here exercises the real persistence hop:
      // LlmAgent merges the LlmResponse into the model response event, and the
      // session service appends that event to the session.
      afterModelCallback: ({response}) => {
        modelResponseCount++;
        if (modelResponseCount > 1) {
          return undefined;
        }
        return {...response, cacheMetadata: TURN_1_CACHE_METADATA};
      },
    });

    const mockResponses = [
      // Turn 1 response: returns promptTokenCount 4500.
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Hello! I cached the initial context.'}],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 4500,
          candidatesTokenCount: 15,
          totalTokenCount: 4515,
        },
      },
      // Turn 2 response
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Sure, here is more information.'}],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 4600,
          candidatesTokenCount: 20,
          totalTokenCount: 4620,
        },
      },
    ];

    agent.model = new GeminiWithMockResponses(mockResponses);

    const appName = agent.name;
    const userId = 'test_user';
    const runner = new InMemoryRunner({agent, appName});
    const session = await runner.sessionService.createSession({
      appName,
      userId,
    });

    // --- Turn 1 ---
    for await (const _event of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: createUserContent('Hello there'),
    })) {
      // consume
    }

    expect(capturedRequests).toHaveLength(1);
    // Turn 1 request has cacheConfig attached, but no cacheMetadata yet since it's turn 1
    expect(capturedRequests[0].cacheConfig).toEqual({
      cacheIntervals: 10,
      ttlSeconds: 1800,
      minTokens: 4096,
    });
    expect(capturedRequests[0].cacheMetadata).toBeUndefined();
    expect(capturedRequests[0].cacheableContentsTokenCount).toBeUndefined();

    // The cache metadata carried on the model response must have been
    // persisted by the session service, not merely observed in the stream.
    const persisted = await runner.sessionService.getSession({
      appName,
      userId,
      sessionId: session.id,
    });
    expect(
      persisted?.events.find((event) => event.cacheMetadata !== undefined)
        ?.cacheMetadata,
    ).toEqual(TURN_1_CACHE_METADATA);

    // --- Turn 2 ---
    for await (const _event of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: createUserContent('Give me details'),
    })) {
      // consume
    }

    expect(capturedRequests).toHaveLength(2);
    // Turn 2 request should have cacheConfig, plus resolved cacheMetadata (with incremented invocationsUsed) and previous promptTokenCount
    expect(capturedRequests[1].cacheConfig).toEqual({
      cacheIntervals: 10,
      ttlSeconds: 1800,
      minTokens: 4096,
    });
    expect(capturedRequests[1].cacheMetadata).toEqual({
      ...TURN_1_CACHE_METADATA,
      invocationsUsed: 2, // incremented across turn/invocation boundary
    });
    expect(capturedRequests[1].cacheableContentsTokenCount).toBe(4500);
  });
});
