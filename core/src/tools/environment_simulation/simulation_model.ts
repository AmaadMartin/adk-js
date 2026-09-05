/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, createUserContent} from '@google/genai';

import {LlmRequest} from '../../models/llm_request.js';
import {LLMRegistry} from '../../models/registry.js';

/** Removes a leading ```lang fence line. */
const LEADING_FENCE_PATTERN = /^```[a-zA-Z]*\n/;

/** Removes a trailing ``` fence line. */
const TRAILING_FENCE_PATTERN = /\n```$/;

/**
 * Asks the simulation model for one answer and returns its text.
 *
 * The model is resolved when it is called rather than when the engine is
 * built, so a configuration that only injects responses never resolves a model
 * at all.
 *
 * @param params.model The name of the model to call.
 * @param params.modelConfig The configuration of that call.
 * @param params.prompt The prompt to send.
 * @returns Every text part the model produced, concatenated.
 * @throws {Error} When no registered model matches `params.model`.
 */
export async function generateSimulationText(params: {
  model: string;
  modelConfig: GenerateContentConfig;
  prompt: string;
}): Promise<string> {
  const request: LlmRequest = {
    model: params.model,
    contents: [createUserContent(params.prompt)],
    config: params.modelConfig,
    liveConnectConfig: {},
    toolsDict: {},
  };

  const llm = LLMRegistry.newLlm(params.model);
  let responseText = '';
  for await (const response of llm.generateContentAsync(request)) {
    for (const part of response.content?.parts ?? []) {
      if (part.text) {
        responseText += part.text;
      }
    }
  }
  return responseText;
}

/**
 * Removes the Markdown code fence a model often wraps JSON in.
 *
 * @param text The raw model answer.
 * @returns The answer without its fence, trimmed.
 */
export function stripJsonFence(text: string): string {
  return text
    .replace(LEADING_FENCE_PATTERN, '')
    .replace(TRAILING_FENCE_PATTERN, '')
    .trim();
}
