/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AnthropicLlm, Claude, LlmRequest, LlmResponse} from '@google/adk';
import {describe, expect, it} from 'vitest';

const isCI = process.env.CI === 'true';
const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
const hasVertexConfig = Boolean(
  process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_LOCATION,
);

function textRequest(model: string): LlmRequest {
  return {
    model,
    contents: [{role: 'user', parts: [{text: 'What is 2 + 2?'}]}],
    config: {
      systemInstruction: 'Answer with the number only.',
    },
    liveConnectConfig: {},
    toolsDict: {},
  };
}

async function firstResponse(
  responses: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse> {
  for await (const response of responses) {
    return response;
  }
  return expect.fail('The model yielded no response.');
}

describe.skipIf(isCI || !hasAnthropicKey)('Live Claude direct API', () => {
  it('answers a text turn', async () => {
    const model = 'claude-sonnet-4-20250514';
    const llm = new AnthropicLlm({model});

    const response = await firstResponse(
      llm.generateContentAsync(textRequest(model), false),
    );

    expect(response.content?.role).toBe('model');
    expect(response.content?.parts?.[0].text).toContain('4');
    expect(response.usageMetadata?.totalTokenCount).toBeGreaterThan(0);
  });
});

describe.skipIf(isCI || !hasVertexConfig)('Live Claude on Vertex AI', () => {
  it('answers a text turn', async () => {
    const model = 'claude-3-5-sonnet-v2@20241022';
    const llm = new Claude({model});

    const response = await firstResponse(
      llm.generateContentAsync(textRequest(model), false),
    );

    expect(response.content?.role).toBe('model');
    expect(response.content?.parts?.[0].text).toContain('4');
    expect(response.usageMetadata?.totalTokenCount).toBeGreaterThan(0);
  });
});
