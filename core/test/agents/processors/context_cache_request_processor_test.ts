/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CONTEXT_CACHE_REQUEST_PROCESSOR,
  ContextCacheConfig,
  createEvent,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const CACHE_CONFIG: ContextCacheConfig = {ttlSeconds: 1800, minTokens: 5000};

const AGENT = new LlmAgent({name: 'cached_agent', model: 'gemini-2.5-flash'});

/** Builds an event this agent authored, carrying a prompt token count. */
function agentTurn(author: string, promptTokenCount?: number) {
  return createEvent({
    author,
    content: {role: 'model', parts: [{text: 'hi'}]},
    usageMetadata:
      promptTokenCount === undefined ? undefined : {promptTokenCount},
  });
}

/** Runs the processor over a session and returns the request it populated. */
async function runProcessor(options: {
  contextCacheConfig?: ContextCacheConfig;
  events?: ReturnType<typeof createEvent>[];
}): Promise<LlmRequest> {
  const llmRequest: LlmRequest = {
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
  };
  const invocationContext = new InvocationContext({
    invocationId: 'inv_1',
    agent: AGENT,
    session: createSession({
      id: 'sess_1',
      appName: 'test-app',
      userId: 'test-user',
      events: options.events ?? [],
    }),
    pluginManager: new PluginManager(),
    contextCacheConfig: options.contextCacheConfig,
  });

  for await (const _ of CONTEXT_CACHE_REQUEST_PROCESSOR.runAsync(
    invocationContext,
    llmRequest,
  )) {
    expect.fail('the processor emitted an event');
  }
  return llmRequest;
}

describe('ContextCacheRequestProcessor', () => {
  it('leaves the request untouched when the app configures no cache', async () => {
    const llmRequest = await runProcessor({
      events: [agentTurn('cached_agent', 9000)],
    });

    expect(llmRequest.cacheConfig).toBeUndefined();
    expect(llmRequest.cacheableContentsTokenCount).toBeUndefined();
  });

  it('publishes the app cache config on the request', async () => {
    const llmRequest = await runProcessor({contextCacheConfig: CACHE_CONFIG});

    expect(llmRequest.cacheConfig).toBe(CACHE_CONFIG);
  });

  it('reports no prompt size before the agent has answered', async () => {
    const llmRequest = await runProcessor({contextCacheConfig: CACHE_CONFIG});

    expect(llmRequest.cacheableContentsTokenCount).toBeUndefined();
  });

  it('reports the agent latest prompt size', async () => {
    const llmRequest = await runProcessor({
      contextCacheConfig: CACHE_CONFIG,
      events: [
        agentTurn('cached_agent', 6000),
        agentTurn('cached_agent', 9000),
      ],
    });

    expect(llmRequest.cacheableContentsTokenCount).toBe(9000);
  });

  it('ignores the prompt size of another agent', async () => {
    const llmRequest = await runProcessor({
      contextCacheConfig: CACHE_CONFIG,
      events: [agentTurn('cached_agent', 6000), agentTurn('other_agent', 9000)],
    });

    expect(llmRequest.cacheableContentsTokenCount).toBe(6000);
  });

  it('skips an own turn that reports no prompt size', async () => {
    const llmRequest = await runProcessor({
      contextCacheConfig: CACHE_CONFIG,
      events: [agentTurn('cached_agent', 6000), agentTurn('cached_agent')],
    });

    expect(llmRequest.cacheableContentsTokenCount).toBe(6000);
  });
});
