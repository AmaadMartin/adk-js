/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AnthropicLlm, LLMRegistry, LlmRequest} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

import {anthropicMessage} from './anthropic_test_utils.js';

const {loadSdk, create} = vi.hoisted(() => ({
  loadSdk: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  loadSdk();
  return {
    Anthropic: class {
      messages = {create};
      apiKey = 'test-key';
      authToken = null;
      credentials = null;
    },
  };
});

function makeRequest(): LlmRequest {
  return {
    model: 'claude-sonnet-4-20250514',
    contents: [{role: 'user', parts: [{text: 'Hi'}]}],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/**
 * This file holds a single ordered test on purpose: the module registry is
 * per file, so the SDK load can only be observed as not-yet-happened once.
 */
describe('optional peer loading', () => {
  it('loads the Anthropic SDK on the first request, not on import', async () => {
    create.mockResolvedValue(anthropicMessage([]));

    expect(LLMRegistry.resolve('claude-sonnet-4-20250514')).toBeDefined();
    const llm = new AnthropicLlm();
    expect(loadSdk).not.toHaveBeenCalled();

    for await (const response of llm.generateContentAsync(makeRequest())) {
      expect(response.content?.role).toBe('model');
    }

    expect(loadSdk).toHaveBeenCalledOnce();
  });
});
