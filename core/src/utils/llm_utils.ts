/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helpers for asking a model for one JSON document and reading the answer
 * back, for the callers that treat a model as a structured-output function
 * rather than as a conversation.
 */

import {GenerateContentConfig} from '@google/genai';

import {BaseLlm} from '../models/base_llm.js';
import {LlmRequest} from '../models/llm_request.js';

/** Matches an opening markdown code fence, with an optional language tag. */
const LEADING_CODE_FENCE = /^```[a-zA-Z]*\n/;

/** Matches a closing markdown code fence, with an optional trailing newline. */
const TRAILING_CODE_FENCE = /\n```\n?$/;

/**
 * Sends `prompt` as a single user turn asking for JSON, and concatenates the
 * text of every part of every streamed response.
 *
 * @param llm The model to send the prompt to.
 * @param config The generation config, merged with a JSON response mime type.
 * @param prompt The single user prompt to send.
 * @returns The concatenated response text.
 */
export async function generateJsonText(
  llm: BaseLlm,
  config: GenerateContentConfig,
  prompt: string,
): Promise<string> {
  const request: LlmRequest = {
    model: llm.model,
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
 *     JSON has no `undefined` literal, so a successful parse can never return
 *     `undefined` and the sentinel is unambiguous. Callers decide how to
 *     recover from bad output, so this never throws.
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

/**
 * Whether `value` is a JSON object, as opposed to an array or a primitive.
 *
 * Pairs with {@link parseFencedJson}, whose result is only usable as a record
 * once narrowed.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
