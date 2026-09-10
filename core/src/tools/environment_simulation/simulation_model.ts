/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {BaseLlm} from '../../models/base_llm.js';
import {LlmRequest} from '../../models/llm_request.js';

/** Matches the opening fence of a Markdown code block, with its language. */
const LEADING_CODE_FENCE = /^```[a-zA-Z]*\n/;

/**
 * Matches the closing fence of a Markdown code block.
 *
 * The trailing newline is optional because adk-python anchors with `$`, which
 * Python also matches just before a final newline.
 */
const TRAILING_CODE_FENCE = /\n```\n?$/;

/**
 * Asks the simulation model for one JSON document and returns its raw text.
 *
 * The text of every part of every streamed response is concatenated, so a
 * document split across chunks arrives whole. Nothing is stripped or parsed
 * here: the caller needs the raw text to report what the model actually said.
 *
 * @param params.llm The model to call.
 * @param params.modelName The name the request carries.
 * @param params.modelConfig The caller's generation config.
 * @param params.prompt The prompt to send as a single user turn.
 * @returns The concatenated text of the response.
 */
export async function generateSimulationText(params: {
  llm: BaseLlm;
  modelName: string;
  modelConfig: GenerateContentConfig;
  prompt: string;
}): Promise<string> {
  const request: LlmRequest = {
    model: params.modelName,
    contents: [{role: 'user', parts: [{text: params.prompt}]}],
    // adk-python sets `response_mime_type` on a second `generation_config`
    // field that adk-js's LlmRequest does not have, so it is merged in here.
    config: {...params.modelConfig, responseMimeType: 'application/json'},
    liveConnectConfig: {},
    toolsDict: {},
  };

  let text = '';
  for await (const response of params.llm.generateContentAsync(request)) {
    for (const part of response.content?.parts ?? []) {
      if (part.text) {
        text += part.text;
      }
    }
  }
  return text;
}

/**
 * Removes the Markdown code fence a model may have wrapped JSON in, and trims.
 *
 * @param text The raw text the model produced.
 * @returns The text with an opening and closing fence removed.
 */
export function stripJsonCodeFence(text: string): string {
  return text
    .replace(LEADING_CODE_FENCE, '')
    .replace(TRAILING_CODE_FENCE, '')
    .trim();
}
