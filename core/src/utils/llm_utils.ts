/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {BaseLlm} from '../models/base_llm.js';
import {LlmRequest} from '../models/llm_request.js';

/** Parameters for {@link generateJsonText}. */
export interface GenerateJsonTextParams {
  /** The model to send the prompt to. */
  llm: BaseLlm;
  /** The model name recorded on the request. */
  model: string;
  /** The generation config to send, merged with a JSON response mime type. */
  config: GenerateContentConfig;
  /** The single user prompt to send. */
  prompt: string;
}

const LEADING_CODE_FENCE = /^```[a-zA-Z]*\n/;
const TRAILING_CODE_FENCE = /\n```$/;

/**
 * Sends a single-prompt request asking for JSON to `llm` and concatenates the
 * text parts of every streamed response.
 *
 * @param params The model, model name, generation config and prompt.
 * @returns The concatenated response text.
 */
export async function generateJsonText({
  llm,
  model,
  config,
  prompt,
}: GenerateJsonTextParams): Promise<string> {
  const request: LlmRequest = {
    model,
    contents: [{role: 'user', parts: [{text: prompt}]}],
    config: {...config, responseMimeType: 'application/json'},
    liveConnectConfig: {},
    toolsDict: {},
  };

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
 * Strips a surrounding markdown code fence, then parses the result as JSON.
 *
 * @param text The raw model output.
 * @returns The parsed value, or `undefined` when the text is not valid JSON.
 *     Callers decide how to recover, so this never throws.
 */
export function parseFencedJson(text: string): unknown {
  const unfenced = text
    .replace(LEADING_CODE_FENCE, '')
    .replace(TRAILING_CODE_FENCE, '')
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    return undefined;
  }
}
