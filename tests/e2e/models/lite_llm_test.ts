/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LiteLlm, LlmRequest} from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * Exercises a real endpoint, so it is skipped unless one is configured.
 *
 * Point `LITELLM_API_BASE` at an OpenAI-compatible `/v1` endpoint (a LiteLLM
 * Proxy deployment, OpenAI, or a local Ollama or vLLM server), set
 * `LITELLM_API_KEY` if it needs one, and set `LITELLM_MODEL` to a model that
 * endpoint serves.
 */
const apiBase = process.env['LITELLM_API_BASE'];
const model = process.env['LITELLM_MODEL'] ?? 'openai/gpt-4o-mini';

describe.skipIf(!apiBase)('LiteLlm against a real endpoint', () => {
  it('answers one completion', async () => {
    const llm = new LiteLlm({
      model,
      apiBase,
      apiKey: process.env['LITELLM_API_KEY'],
    });
    const llmRequest: LlmRequest = {
      contents: [{role: 'user', parts: [{text: 'Reply with the word OK.'}]}],
      config: {systemInstruction: 'Answer in one word.', maxOutputTokens: 16},
      liveConnectConfig: {},
      toolsDict: {},
    };

    const responses = [];
    for await (const response of llm.generateContentAsync(llmRequest)) {
      responses.push(response);
    }

    expect(responses).toHaveLength(1);
    expect(responses[0].content?.parts?.[0].text).toBeTruthy();
  });
});
