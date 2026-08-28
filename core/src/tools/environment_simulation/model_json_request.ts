/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createUserContent, GenerateContentConfig} from '@google/genai';

import {BaseLlm} from '../../models/base_llm.js';
import {LlmRequest} from '../../models/llm_request.js';

/** The indent every prompt payload is serialized with. */
export const JSON_INDENT = 2;

/** Matches an opening markdown fence and its optional language tag. */
const OPENING_FENCE = /^```[a-zA-Z]*\n?/;

/** Matches a closing markdown fence at the end of the text. */
const CLOSING_FENCE = /\n?```$/;

/**
 * Sends a one-shot prompt to a model and returns the text it produced.
 *
 * @param llm The model to call.
 * @param prompt The prompt to send.
 * @param config The generation config to apply.
 * @return The concatenated text of every streamed part.
 */
export async function requestJsonFromModel(
  llm: BaseLlm,
  prompt: string,
  config: GenerateContentConfig,
): Promise<string> {
  const request: LlmRequest = {
    model: llm.model,
    contents: [createUserContent(prompt)],
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
 * Parses a model's reply as JSON, unwrapping a markdown fence first.
 *
 * A model can answer with prose even when it was asked for JSON, so a parse
 * failure is a normal outcome rather than an error.
 *
 * @param text The reply to parse.
 * @return The parsed value, or `undefined` when the reply is not JSON.
 */
export function parseJsonFromModelText(text: string): unknown {
  const payload = text
    .trim()
    .replace(OPENING_FENCE, '')
    .replace(CLOSING_FENCE, '')
    .trim();
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}
