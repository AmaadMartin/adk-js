/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';

import type {LlmAgent} from '../agents/llm_agent.js';
import type {BaseLlm} from '../models/base_llm.js';
import type {LlmRequest} from '../models/llm_request.js';

/** Parameters for {@link generateReflectionResponse}. */
export interface GenerateReflectionResponseParams {
  /** The model that answers the reflection request. */
  llm: BaseLlm;

  /** The model name to put on the request. */
  model: string;

  /** The generation config to put on the request. */
  config: GenerateContentConfig;

  /** The reflection prompt the engine produced. */
  prompt: string;
}

/**
 * Returns the instruction that can seed an offline GEPA optimization.
 *
 * @param agent The agent whose root instruction is optimized.
 * @throws If the instruction is a provider function rather than a string.
 */
export function requireStaticInstruction(agent: LlmAgent): string {
  const instruction = agent.instruction;
  if (typeof instruction !== 'string') {
    throw new Error(
      'GEPA optimization requires initialAgent.instruction to be a static' +
        ' string; request-scoped instruction providers cannot be resolved' +
        ' without an invocation context.',
    );
  }
  return instruction;
}

/**
 * Runs one GEPA reflection request and returns all non-thought text.
 *
 * @param params The model, the request fields, and the reflection prompt.
 * @returns The concatenated text of the first response, thoughts excluded.
 */
export async function generateReflectionResponse({
  llm,
  model,
  config,
  prompt,
}: GenerateReflectionResponseParams): Promise<string> {
  const request: LlmRequest = {
    model,
    config,
    contents: [{role: 'user', parts: [{text: prompt}]}],
    toolsDict: {},
    liveConnectConfig: {},
  };

  const responses = llm.generateContentAsync(request, false);
  try {
    // Only one yield is expected, so there is no need to loop.
    const first = await responses.next();
    if (first.done) {
      return '';
    }
    let text = '';
    for (const part of first.value.content?.parts ?? []) {
      if (part.text && !part.thought) {
        text += part.text;
      }
    }
    return text;
  } finally {
    await responses.return(undefined);
  }
}
