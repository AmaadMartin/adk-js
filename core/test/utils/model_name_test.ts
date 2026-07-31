/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isGemini2OrAbove, isGemini3xFlashLive} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('isGemini2OrAbove', () => {
  describe('valid models', () => {
    const validModels = [
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
      'gemini-3-pro-image-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash-image',
      'gemini-2.5-flash',
      'gemini-2.5-flash-preview-09-2025',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash-lite-preview-09-2025',
      'gemini-2.0-flash-001',
      'gemini-2.0-flash-lite-001',
    ];

    for (const model of validModels) {
      it(`should return true for model: ${model}`, () => {
        expect(isGemini2OrAbove(model)).toBe(true);
      });
    }
  });

  describe('invalid models', () => {
    const invalidModels = [
      'gemini-live-2.5-flash-native-audio',
      'veo-3.1-generate-001',
      'veo-3.0-fast-generate-001',
      'imagen-4.0-ultra-generate-001',
      'imagen-3.0-generate-001',
      'deepseek-ocr-maas',
      'kimi-k2-thinking-maas',
      'llama-4-scout-17b-16e-instruct-maas',
      'minimax-m2-maas',
      'gpt-oss-120b-maas',
      'qwen3-next-80b-a3b-instruct-maas',
      'gemini-1.5-pro',
      'gemini-1.0-pro',
    ];

    for (const model of invalidModels) {
      it(`should return false for model: ${model}`, () => {
        expect(isGemini2OrAbove(model)).toBe(false);
      });
    }
  });

  describe('EAP models', () => {
    const eapModels = [
      'gemini-flash-early-exp',
      'gemini-flash-early-exp3',
      'gemini-flash-early-exp12',
      'gemini-flash-lite-early-exp',
      'gemini-pro-early-exp',
      'gemini-flash_lite-early-exp',
      'projects/my-project/locations/us-central1/publishers/google/models/gemini-flash-early-exp',
    ];

    for (const model of eapModels) {
      it(`should return true for EAP model: ${model}`, () => {
        expect(isGemini2OrAbove(model)).toBe(true);
      });
    }

    const nonEapModels = [
      'gemini-flash-early',
      'gemini-early-exp-flash',
      'gemini-early-exp',
      'gemini-flash-early-exp-001',
      'gemini-Flash-early-exp',
      'my-gemini-flash-early-exp',
      'claude-3.7-sonnet',
    ];

    for (const model of nonEapModels) {
      it(`should return false for non-EAP model: ${model}`, () => {
        expect(isGemini2OrAbove(model)).toBe(false);
      });
    }

    it('should not let the EAP pattern reclassify a Gemini 1.x model', () => {
      // The EAP character class excludes '.', so a 1.x name carrying the
      // suffix cannot match and stays below the 2.0 bar.
      expect(isGemini2OrAbove('gemini-1.5-flash-early-exp')).toBe(false);
    });
  });
});

describe('isGemini3xFlashLive', () => {
  it('should return true for valid Gemini 3.x Flash Live models', () => {
    expect(isGemini3xFlashLive('gemini-3.1-flash-live')).toBe(true);
    expect(isGemini3xFlashLive('gemini-3.1-flash-live-preview')).toBe(true);
    expect(isGemini3xFlashLive('gemini-3.5-flash-live')).toBe(true);
    expect(isGemini3xFlashLive('gemini-3.5-flash-live-preview')).toBe(true);
    expect(
      isGemini3xFlashLive(
        'projects/my-project/locations/us-central1/publishers/google/models/gemini-3.1-flash-live-001',
      ),
    ).toBe(true);
    expect(
      isGemini3xFlashLive(
        'projects/my-project/locations/us-central1/publishers/google/models/gemini-3.5-flash-live-001',
      ),
    ).toBe(true);
  });

  it('should return false for other models', () => {
    expect(isGemini3xFlashLive('gemini-2.5-flash')).toBe(false);
    expect(isGemini3xFlashLive('gemini-3.0-flash')).toBe(false);
    expect(isGemini3xFlashLive(undefined)).toBe(false);
    expect(isGemini3xFlashLive('')).toBe(false);
  });
});
