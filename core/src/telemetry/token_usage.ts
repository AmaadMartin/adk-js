/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentResponseUsageMetadata} from '@google/genai';
import {Attributes} from '@opentelemetry/api';

import {
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
} from './semconv.js';

/**
 * Adds two optional token counts, preserving the distinction between "no
 * counts reported" (`undefined`) and "counts reported, and they are zero".
 */
function addTokenCounts(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  return (a ?? 0) + (b ?? 0);
}

/**
 * Prompt and tool-use tokens, which the GenAI semantic conventions bucket
 * together as `input`.
 */
export function inputTokenCount(
  usageMetadata?: GenerateContentResponseUsageMetadata,
): number | undefined {
  return addTokenCounts(
    usageMetadata?.promptTokenCount,
    usageMetadata?.toolUsePromptTokenCount,
  );
}

/**
 * Candidate and reasoning tokens. The semantic conventions require
 * `gen_ai.usage.reasoning.output_tokens` to be included in the output total.
 */
export function outputTokenCount(
  usageMetadata?: GenerateContentResponseUsageMetadata,
): number | undefined {
  return addTokenCounts(
    usageMetadata?.candidatesTokenCount,
    usageMetadata?.thoughtsTokenCount,
  );
}

/**
 * Returns the OpenTelemetry token usage attributes, omitting unknowns.
 *
 * Cached content tokens are reported on their own attribute rather than added
 * to the input total, because they are already part of the prompt tokens.
 */
export function tokenUsageAttributes(
  usageMetadata?: GenerateContentResponseUsageMetadata,
): Attributes {
  const attributes: Attributes = {};
  const input = inputTokenCount(usageMetadata);
  if (input !== undefined) {
    attributes[GEN_AI_USAGE_INPUT_TOKENS] = input;
  }
  const output = outputTokenCount(usageMetadata);
  if (output !== undefined) {
    attributes[GEN_AI_USAGE_OUTPUT_TOKENS] = output;
  }
  if (usageMetadata?.cachedContentTokenCount !== undefined) {
    attributes[GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS] =
      usageMetadata.cachedContentTokenCount;
  }
  if (usageMetadata?.thoughtsTokenCount !== undefined) {
    attributes[GEN_AI_USAGE_REASONING_OUTPUT_TOKENS] =
      usageMetadata.thoughtsTokenCount;
  }
  return attributes;
}
