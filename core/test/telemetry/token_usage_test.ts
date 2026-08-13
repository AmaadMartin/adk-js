/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentResponseUsageMetadata} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {TokenUsage} from '../../src/telemetry/token_usage.js';

// Spelled out rather than imported: these keys are a wire contract shared
// with adk-python, so the test must fail if the module renames one.
const INPUT_TOKENS = 'gen_ai.usage.input_tokens';
const OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
const CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens';
const REASONING_OUTPUT_TOKENS = 'gen_ai.usage.reasoning.output_tokens';
const SYSTEM_INSTRUCTION_TOKENS =
  'gen_ai.usage.experimental.system_instruction_tokens';

interface UsageMetadataWithSystemInstructionTokens extends GenerateContentResponseUsageMetadata {
  systemInstructionTokens?: number;
}

describe('TokenUsage', () => {
  describe('inputTokenCount', () => {
    it('sums prompt and tool use tokens', () => {
      const usage = new TokenUsage({
        promptTokenCount: 10,
        toolUsePromptTokenCount: 5,
      });

      expect(usage.inputTokenCount).toBe(15);
    });

    it('returns the prompt tokens when tool use tokens are undefined', () => {
      const usage = new TokenUsage({
        promptTokenCount: 10,
        toolUsePromptTokenCount: undefined,
      });

      expect(usage.inputTokenCount).toBe(10);
    });

    it('returns the tool use tokens when prompt tokens are undefined', () => {
      const usage = new TokenUsage({
        promptTokenCount: undefined,
        toolUsePromptTokenCount: 5,
      });

      expect(usage.inputTokenCount).toBe(5);
    });

    it('returns undefined when neither count is reported', () => {
      const usage = new TokenUsage({
        promptTokenCount: undefined,
        toolUsePromptTokenCount: undefined,
      });

      expect(usage.inputTokenCount).toBeUndefined();
    });

    it('returns 0, not undefined, when both counts are zero', () => {
      const usage = new TokenUsage({
        promptTokenCount: 0,
        toolUsePromptTokenCount: 0,
      });

      expect(usage.inputTokenCount).toBe(0);
    });

    it('returns undefined when there is no usage metadata', () => {
      expect(new TokenUsage(undefined).inputTokenCount).toBeUndefined();
    });

    it('returns the prompt tokens when the tool use field is absent', () => {
      const usage = new TokenUsage({promptTokenCount: 10});

      expect(usage.inputTokenCount).toBe(10);
    });
  });

  describe('outputTokenCount', () => {
    it('sums candidate and reasoning tokens', () => {
      const usage = new TokenUsage({
        candidatesTokenCount: 20,
        thoughtsTokenCount: 8,
      });

      expect(usage.outputTokenCount).toBe(28);
    });

    it('returns the candidate tokens when reasoning tokens are undefined', () => {
      const usage = new TokenUsage({
        candidatesTokenCount: 20,
        thoughtsTokenCount: undefined,
      });

      expect(usage.outputTokenCount).toBe(20);
    });

    it('returns the reasoning tokens when candidate tokens are undefined', () => {
      const usage = new TokenUsage({
        candidatesTokenCount: undefined,
        thoughtsTokenCount: 8,
      });

      expect(usage.outputTokenCount).toBe(8);
    });

    it('returns undefined when neither count is reported', () => {
      const usage = new TokenUsage({
        candidatesTokenCount: undefined,
        thoughtsTokenCount: undefined,
      });

      expect(usage.outputTokenCount).toBeUndefined();
    });

    it('returns 0, not undefined, when both counts are zero', () => {
      const usage = new TokenUsage({
        candidatesTokenCount: 0,
        thoughtsTokenCount: 0,
      });

      expect(usage.outputTokenCount).toBe(0);
    });

    it('returns undefined when there is no usage metadata', () => {
      expect(new TokenUsage(undefined).outputTokenCount).toBeUndefined();
    });
  });

  describe('toAttributes', () => {
    it('emits every attribute when every count is reported', () => {
      const usage = new TokenUsage({
        promptTokenCount: 10,
        toolUsePromptTokenCount: 5,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 8,
        cachedContentTokenCount: 100,
      });

      expect(usage.toAttributes()).toEqual({
        [INPUT_TOKENS]: 15,
        [OUTPUT_TOKENS]: 28,
        [CACHE_READ_INPUT_TOKENS]: 100,
        [REASONING_OUTPUT_TOKENS]: 8,
      });
    });

    it('omits the keys whose counts are undefined', () => {
      const usage = new TokenUsage({
        promptTokenCount: 10,
        toolUsePromptTokenCount: undefined,
        candidatesTokenCount: undefined,
        thoughtsTokenCount: undefined,
        cachedContentTokenCount: undefined,
      });

      const attributes = usage.toAttributes();

      expect(attributes[INPUT_TOKENS]).toBe(10);
      expect(attributes).not.toHaveProperty(OUTPUT_TOKENS);
      expect(attributes).not.toHaveProperty(CACHE_READ_INPUT_TOKENS);
      expect(attributes).not.toHaveProperty(REASONING_OUTPUT_TOKENS);
    });

    it('emits nothing when there is no usage metadata', () => {
      expect(new TokenUsage(undefined).toAttributes()).toEqual({});
    });

    it('emits zeros rather than dropping the keys', () => {
      const usage = new TokenUsage({
        promptTokenCount: 0,
        toolUsePromptTokenCount: 0,
        candidatesTokenCount: 0,
        thoughtsTokenCount: 0,
        cachedContentTokenCount: 0,
      });

      expect(usage.toAttributes()).toEqual({
        [INPUT_TOKENS]: 0,
        [OUTPUT_TOKENS]: 0,
        [CACHE_READ_INPUT_TOKENS]: 0,
        [REASONING_OUTPUT_TOKENS]: 0,
      });
    });

    it('emits the totals when the optional breakdowns are absent', () => {
      const usage = new TokenUsage({
        promptTokenCount: 10,
        candidatesTokenCount: 20,
      });

      const attributes = usage.toAttributes();

      expect(attributes[INPUT_TOKENS]).toBe(10);
      expect(attributes[OUTPUT_TOKENS]).toBe(20);
    });

    it('emits the system instruction tokens the SDK does not declare', () => {
      const metadata: UsageMetadataWithSystemInstructionTokens = {
        promptTokenCount: 10,
        systemInstructionTokens: 7,
      };

      expect(new TokenUsage(metadata).toAttributes()).toEqual({
        [INPUT_TOKENS]: 10,
        [SYSTEM_INSTRUCTION_TOKENS]: 7,
      });
    });

    it('omits the system instruction tokens when the backend omits them', () => {
      const attributes = new TokenUsage({promptTokenCount: 10}).toAttributes();

      expect(attributes).not.toHaveProperty(SYSTEM_INSTRUCTION_TOKENS);
    });
  });
});
