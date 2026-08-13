/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  inputTokenCount,
  outputTokenCount,
  tokenUsageAttributes,
} from '../../src/telemetry/token_usage.js';

// Spelled out rather than imported: these keys are a wire contract shared
// with adk-python, so the test must fail if the module renames one.
const INPUT_TOKENS = 'gen_ai.usage.input_tokens';
const OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
const CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens';
const REASONING_OUTPUT_TOKENS = 'gen_ai.usage.reasoning.output_tokens';

describe('token usage', () => {
  describe('inputTokenCount', () => {
    it('sums prompt and tool use tokens', () => {
      const metadata = {
        promptTokenCount: 10,
        toolUsePromptTokenCount: 5,
      };

      expect(inputTokenCount(metadata)).toBe(15);
    });

    it('returns the prompt tokens when tool use tokens are undefined', () => {
      const metadata = {
        promptTokenCount: 10,
        toolUsePromptTokenCount: undefined,
      };

      expect(inputTokenCount(metadata)).toBe(10);
    });

    it('returns the tool use tokens when prompt tokens are undefined', () => {
      const metadata = {
        promptTokenCount: undefined,
        toolUsePromptTokenCount: 5,
      };

      expect(inputTokenCount(metadata)).toBe(5);
    });

    it('returns undefined when neither count is reported', () => {
      const metadata = {
        promptTokenCount: undefined,
        toolUsePromptTokenCount: undefined,
      };

      expect(inputTokenCount(metadata)).toBeUndefined();
    });

    it('returns 0, not undefined, when both counts are zero', () => {
      const metadata = {
        promptTokenCount: 0,
        toolUsePromptTokenCount: 0,
      };

      expect(inputTokenCount(metadata)).toBe(0);
    });

    it('returns undefined when there is no usage metadata', () => {
      expect(inputTokenCount(undefined)).toBeUndefined();
    });

    it('returns the prompt tokens when the tool use field is absent', () => {
      const metadata = {promptTokenCount: 10};

      expect(inputTokenCount(metadata)).toBe(10);
    });
  });

  describe('outputTokenCount', () => {
    it('sums candidate and reasoning tokens', () => {
      const metadata = {
        candidatesTokenCount: 20,
        thoughtsTokenCount: 8,
      };

      expect(outputTokenCount(metadata)).toBe(28);
    });

    it('returns the candidate tokens when reasoning tokens are undefined', () => {
      const metadata = {
        candidatesTokenCount: 20,
        thoughtsTokenCount: undefined,
      };

      expect(outputTokenCount(metadata)).toBe(20);
    });

    it('returns the reasoning tokens when candidate tokens are undefined', () => {
      const metadata = {
        candidatesTokenCount: undefined,
        thoughtsTokenCount: 8,
      };

      expect(outputTokenCount(metadata)).toBe(8);
    });

    it('returns undefined when neither count is reported', () => {
      const metadata = {
        candidatesTokenCount: undefined,
        thoughtsTokenCount: undefined,
      };

      expect(outputTokenCount(metadata)).toBeUndefined();
    });

    it('returns 0, not undefined, when both counts are zero', () => {
      const metadata = {
        candidatesTokenCount: 0,
        thoughtsTokenCount: 0,
      };

      expect(outputTokenCount(metadata)).toBe(0);
    });

    it('returns undefined when there is no usage metadata', () => {
      expect(outputTokenCount(undefined)).toBeUndefined();
    });
  });

  describe('tokenUsageAttributes', () => {
    it('emits every attribute when every count is reported', () => {
      const metadata = {
        promptTokenCount: 10,
        toolUsePromptTokenCount: 5,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 8,
        cachedContentTokenCount: 100,
      };

      expect(tokenUsageAttributes(metadata)).toEqual({
        [INPUT_TOKENS]: 15,
        [OUTPUT_TOKENS]: 28,
        [CACHE_READ_INPUT_TOKENS]: 100,
        [REASONING_OUTPUT_TOKENS]: 8,
      });
    });

    it('omits the keys whose counts are undefined', () => {
      const metadata = {
        promptTokenCount: 10,
        toolUsePromptTokenCount: undefined,
        candidatesTokenCount: undefined,
        thoughtsTokenCount: undefined,
        cachedContentTokenCount: undefined,
      };

      const attributes = tokenUsageAttributes(metadata);

      expect(attributes[INPUT_TOKENS]).toBe(10);
      expect(attributes).not.toHaveProperty(OUTPUT_TOKENS);
      expect(attributes).not.toHaveProperty(CACHE_READ_INPUT_TOKENS);
      expect(attributes).not.toHaveProperty(REASONING_OUTPUT_TOKENS);
    });

    it('emits nothing when there is no usage metadata', () => {
      expect(tokenUsageAttributes(undefined)).toEqual({});
    });

    it('emits zeros rather than dropping the keys', () => {
      const metadata = {
        promptTokenCount: 0,
        toolUsePromptTokenCount: 0,
        candidatesTokenCount: 0,
        thoughtsTokenCount: 0,
        cachedContentTokenCount: 0,
      };

      expect(tokenUsageAttributes(metadata)).toEqual({
        [INPUT_TOKENS]: 0,
        [OUTPUT_TOKENS]: 0,
        [CACHE_READ_INPUT_TOKENS]: 0,
        [REASONING_OUTPUT_TOKENS]: 0,
      });
    });

    it('emits the totals when the optional breakdowns are absent', () => {
      const metadata = {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
      };

      const attributes = tokenUsageAttributes(metadata);

      expect(attributes[INPUT_TOKENS]).toBe(10);
      expect(attributes[OUTPUT_TOKENS]).toBe(20);
    });
  });
});
