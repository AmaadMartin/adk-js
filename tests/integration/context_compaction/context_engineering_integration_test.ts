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
import {createUserContent, UsageMetadata} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

describe('Context Engineering Integration', () => {
  it('should enable context caching and resolve cache metadata and token counts across multiple turns', async () => {
    const capturedRequests: LlmRequest[] = [];

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
    });

    const mockResponses = [
      // Turn 1 response: returns promptTokenCount 4500 and cache metadata
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
        } as unknown as UsageMetadata,
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
        } as unknown as UsageMetadata,
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
    for await (const event of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: createUserContent('Hello there'),
    })) {
      // In Turn 1 response event, simulate attaching cacheMetadata from live model creation
      if (!event.partial && event.content?.role === 'model') {
        event.cacheMetadata = {
          cacheName:
            'projects/123/locations/us-central1/cachedContents/test_cache_001',
          expireTime: 1700000000,
          fingerprint: 'hash_abc123',
          invocationsUsed: 1,
          contentsCount: 12,
        };
      }
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
      cacheName:
        'projects/123/locations/us-central1/cachedContents/test_cache_001',
      expireTime: 1700000000,
      fingerprint: 'hash_abc123',
      invocationsUsed: 2, // incremented across turn/invocation boundary
      contentsCount: 12,
    });
    expect(capturedRequests[1].cacheableContentsTokenCount).toBe(4500);
  });
});
