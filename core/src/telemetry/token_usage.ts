/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentResponseUsageMetadata} from '@google/genai';
import {Attributes} from '@opentelemetry/api';

/** OpenTelemetry GenAI attribute for the number of input tokens used. */
const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';

/** OpenTelemetry GenAI attribute for the number of output tokens used. */
const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';

/** OpenTelemetry GenAI attribute for input tokens served from cache. */
const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS =
  'gen_ai.usage.cache_read.input_tokens';

/** OpenTelemetry GenAI attribute for output tokens spent on reasoning. */
const GEN_AI_USAGE_REASONING_OUTPUT_TOKENS =
  'gen_ai.usage.reasoning.output_tokens';

/**
 * Not part of the GenAI semantic conventions. The spelling stays snake_case
 * and byte-identical to the key adk-python emits so both runtimes land in the
 * same dashboard series.
 */
const GEN_AI_USAGE_SYSTEM_INSTRUCTION_TOKENS =
  'gen_ai.usage.experimental.system_instruction_tokens';

/**
 * Token counts the backend may return but `@google/genai` (2.9.0) does not
 * declare.
 */
interface UsageMetadataWithSystemInstructionTokens extends GenerateContentResponseUsageMetadata {
  systemInstructionTokens?: number;
}

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

/** Centralized representation and processing of GenAI token usage metadata. */
export class TokenUsage {
  constructor(readonly usageMetadata?: GenerateContentResponseUsageMetadata) {}

  /**
   * Prompt and tool-use tokens, which the GenAI semantic conventions bucket
   * together as `input`.
   */
  get inputTokenCount(): number | undefined {
    return addTokenCounts(
      this.usageMetadata?.promptTokenCount,
      this.usageMetadata?.toolUsePromptTokenCount,
    );
  }

  /**
   * Candidate and reasoning tokens. The semantic conventions require
   * `gen_ai.usage.reasoning.output_tokens` to be included in the output total.
   */
  get outputTokenCount(): number | undefined {
    return addTokenCounts(
      this.usageMetadata?.candidatesTokenCount,
      this.usageMetadata?.thoughtsTokenCount,
    );
  }

  /** Returns the OpenTelemetry token usage attributes, omitting unknowns. */
  toAttributes(): Attributes {
    const attributes: Attributes = {};
    const inputTokenCount = this.inputTokenCount;
    if (inputTokenCount !== undefined) {
      attributes[GEN_AI_USAGE_INPUT_TOKENS] = inputTokenCount;
    }
    const outputTokenCount = this.outputTokenCount;
    if (outputTokenCount !== undefined) {
      attributes[GEN_AI_USAGE_OUTPUT_TOKENS] = outputTokenCount;
    }

    const metadata: UsageMetadataWithSystemInstructionTokens | undefined =
      this.usageMetadata;
    if (metadata === undefined) {
      return attributes;
    }
    if (metadata.cachedContentTokenCount !== undefined) {
      attributes[GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS] =
        metadata.cachedContentTokenCount;
    }
    if (metadata.thoughtsTokenCount !== undefined) {
      attributes[GEN_AI_USAGE_REASONING_OUTPUT_TOKENS] =
        metadata.thoughtsTokenCount;
    }
    if (metadata.systemInstructionTokens !== undefined) {
      attributes[GEN_AI_USAGE_SYSTEM_INSTRUCTION_TOKENS] =
        metadata.systemInstructionTokens;
    }
    return attributes;
  }
}
