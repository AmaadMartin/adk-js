/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {UsageMetadata} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {ContextCacheConfig} from '../../../src/agents/context_cache_config.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {LlmAgent} from '../../../src/agents/llm_agent.js';
import {ContextCacheRequestProcessor} from '../../../src/agents/processors/context_cache_request_processor.js';
import {createEvent, Event} from '../../../src/events/event.js';
import {LlmRequest} from '../../../src/models/llm_request.js';
import {PluginManager} from '../../../src/plugins/plugin_manager.js';
import {createSession} from '../../../src/sessions/session.js';

describe('ContextCacheRequestProcessor', () => {
  const processor = new ContextCacheRequestProcessor();

  function createTestInvocationContext(params: {
    agentName?: string;
    invocationId?: string;
    events?: Event[];
    cacheConfig?: ContextCacheConfig;
  }): InvocationContext {
    const agent = new LlmAgent({
      name: params.agentName ?? 'test_agent',
      model: 'gemini-2.5-flash',
      contextCacheConfig: params.cacheConfig,
    });

    const session = createSession({
      appName: 'test_app',
      userId: 'test_user',
    });
    if (params.events) {
      session.events = params.events;
    }

    return new InvocationContext({
      agent,
      session,
      invocationId: params.invocationId ?? 'inv_current',
      pluginManager: new PluginManager(),
      contextCacheConfig: params.cacheConfig,
    });
  }

  it('does nothing if contextCacheConfig is not set', async () => {
    const ic = createTestInvocationContext({
      cacheConfig: undefined,
    });
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {} as unknown as LlmRequest['liveConnectConfig'],
      toolsDict: {},
    };

    for await (const _event of processor.runAsync(ic, request)) {
      // no events yielded
    }

    expect(request.cacheConfig).toBeUndefined();
    expect(request.cacheMetadata).toBeUndefined();
    expect(request.cacheableContentsTokenCount).toBeUndefined();
  });

  it('sets cacheConfig on request and does not find metadata when events list is empty', async () => {
    const cacheConfig = {ttlSeconds: 1800};
    const ic = createTestInvocationContext({
      cacheConfig,
      events: [],
    });
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {} as unknown as LlmRequest['liveConnectConfig'],
      toolsDict: {},
    };

    for await (const _event of processor.runAsync(ic, request)) {
      // no events yielded
    }

    expect(request.cacheConfig).toEqual(cacheConfig);
    expect(request.cacheMetadata).toBeUndefined();
    expect(request.cacheableContentsTokenCount).toBeUndefined();
  });

  it('extracts cacheMetadata and increments invocationsUsed across different invocation boundaries when active cache exists', async () => {
    const cacheConfig = {ttlSeconds: 1800};
    const prevEvent = createEvent({
      invocationId: 'inv_prev',
      author: 'test_agent',
      cacheMetadata: {
        cacheName: 'projects/123/locations/us-central1/cachedContents/456',
        expireTime: 1700000000,
        fingerprint: 'hash_abc',
        invocationsUsed: 2,
        contentsCount: 10,
      },
      usageMetadata: {
        promptTokenCount: 5120,
      } as unknown as UsageMetadata,
    });

    const ic = createTestInvocationContext({
      invocationId: 'inv_current',
      cacheConfig,
      events: [prevEvent],
    });
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {} as unknown as LlmRequest['liveConnectConfig'],
      toolsDict: {},
    };

    for await (const _event of processor.runAsync(ic, request)) {
      // no events yielded
    }

    expect(request.cacheConfig).toEqual(cacheConfig);
    expect(request.cacheMetadata).toEqual({
      cacheName: 'projects/123/locations/us-central1/cachedContents/456',
      expireTime: 1700000000,
      fingerprint: 'hash_abc',
      invocationsUsed: 3, // incremented across invocation boundary
      contentsCount: 10,
    });
    expect(request.cacheableContentsTokenCount).toBe(5120);
    // Ensure session event was not mutated
    expect(prevEvent.cacheMetadata?.invocationsUsed).toBe(2);
  });

  it('does not increment invocationsUsed when event invocationId equals currentInvocationId', async () => {
    const cacheConfig = {ttlSeconds: 1800};
    const sameInvEvent = createEvent({
      invocationId: 'inv_current',
      author: 'test_agent',
      cacheMetadata: {
        cacheName: 'projects/123/locations/us-central1/cachedContents/456',
        expireTime: 1700000000,
        fingerprint: 'hash_abc',
        invocationsUsed: 2,
        contentsCount: 10,
      },
      usageMetadata: {
        promptTokenCount: 6000,
      } as unknown as UsageMetadata,
    });

    const ic = createTestInvocationContext({
      invocationId: 'inv_current',
      cacheConfig,
      events: [sameInvEvent],
    });
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {} as unknown as LlmRequest['liveConnectConfig'],
      toolsDict: {},
    };

    for await (const _event of processor.runAsync(ic, request)) {
      // no events yielded
    }

    expect(request.cacheMetadata?.invocationsUsed).toBe(2);
    expect(request.cacheableContentsTokenCount).toBe(6000);
  });

  it('does not increment invocationsUsed across invocation boundaries when cacheName is undefined (fingerprint-only state)', async () => {
    const cacheConfig = {ttlSeconds: 1800};
    const prevEvent = createEvent({
      invocationId: 'inv_prev',
      author: 'test_agent',
      cacheMetadata: {
        fingerprint: 'hash_xyz',
        contentsCount: 8,
      },
    });

    const ic = createTestInvocationContext({
      invocationId: 'inv_current',
      cacheConfig,
      events: [prevEvent],
    });
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {} as unknown as LlmRequest['liveConnectConfig'],
      toolsDict: {},
    };

    for await (const _event of processor.runAsync(ic, request)) {
      // no events yielded
    }

    expect(request.cacheMetadata).toEqual({
      fingerprint: 'hash_xyz',
      contentsCount: 8,
    });
    expect(request.cacheMetadata?.invocationsUsed).toBeUndefined();
  });

  it('skips events from other authors when searching for cache metadata and token count', async () => {
    const cacheConfig = {ttlSeconds: 1800};
    const otherAgentEvent = createEvent({
      invocationId: 'inv_prev',
      author: 'other_agent',
      cacheMetadata: {
        cacheName: 'projects/123/locations/us-central1/cachedContents/999',
        expireTime: 1700000000,
        fingerprint: 'hash_other',
        invocationsUsed: 5,
        contentsCount: 20,
      },
      usageMetadata: {
        promptTokenCount: 9999,
      } as unknown as UsageMetadata,
    });

    const ourAgentEvent = createEvent({
      invocationId: 'inv_prev',
      author: 'test_agent',
      cacheMetadata: {
        cacheName: 'projects/123/locations/us-central1/cachedContents/111',
        expireTime: 1700000000,
        fingerprint: 'hash_our',
        invocationsUsed: 1,
        contentsCount: 5,
      },
      usageMetadata: {
        promptTokenCount: 4500,
      } as unknown as UsageMetadata,
    });

    const ic = createTestInvocationContext({
      invocationId: 'inv_current',
      cacheConfig,
      events: [ourAgentEvent, otherAgentEvent],
    });
    const request: LlmRequest = {
      contents: [],
      liveConnectConfig: {} as unknown as LlmRequest['liveConnectConfig'],
      toolsDict: {},
    };

    for await (const _event of processor.runAsync(ic, request)) {
      // no events yielded
    }

    expect(request.cacheMetadata?.fingerprint).toBe('hash_our');
    expect(request.cacheMetadata?.invocationsUsed).toBe(2);
    expect(request.cacheableContentsTokenCount).toBe(4500);
  });
});
