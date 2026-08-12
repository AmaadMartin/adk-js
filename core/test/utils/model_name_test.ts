/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isGemini2OrAbove, isGemini3xFlashLive} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {isGemini1Model, isGeminiModel} from '../../src/utils/model_name.js';

describe('isGemini1Model', () => {
  const gemini1Models = [
    'gemini-1.5-flash',
    'gemini-1.0-pro',
    'gemini-1.5-pro-preview',
    'gemini-1.9-experimental',
    'projects/265104255505/locations/us-central1/publishers/google/models/gemini-1.5-flash',
    'projects/12345/locations/us-east1/publishers/google/models/gemini-1.0-pro-preview',
  ];

  describe('valid models', () => {
    for (const model of gemini1Models) {
      it(`should return true for model: ${model}`, () => {
        expect(isGemini1Model(model)).toBe(true);
      });
    }
  });

  describe('invalid models', () => {
    const invalidModels = [
      // A double-digit major must not be read as Gemini 1.x.
      'gemini-10.0-pro',
      // The dotted minor version is mandatory.
      'gemini-1',
      'gemini-1-pro',
      'gemini-1.',
      'gemini-1x-foo',
      'gemini-2.5-flash',
      'claude-3-sonnet',
      // Present but not anchored at the start of the model name.
      'my-gemini-1.5-model',
      '',
      'projects/265104255505/locations/us-central1/publishers/google/models/gemini-2.5-flash',
    ];

    for (const model of invalidModels) {
      it(`should return false for model: ${model || '<empty string>'}`, () => {
        expect(isGemini1Model(model)).toBe(false);
      });
    }
  });

  describe('classification invariants', () => {
    const allModels = [
      ...gemini1Models,
      'gemini-10.0-pro',
      'gemini-1',
      'gemini-1-pro',
      'gemini-2.5-flash',
      'gemini-3-pro-preview',
      'claude-3-sonnet',
      '',
    ];

    it('should never classify a model as both Gemini 1.x and Gemini 2.0+', () => {
      expect(
        allModels.filter(
          (model) => isGemini1Model(model) && isGemini2OrAbove(model),
        ),
      ).toEqual([]);
    });

    it('should classify every Gemini 1.x model as a Gemini model', () => {
      expect(
        allModels.filter(
          (model) => isGemini1Model(model) && !isGeminiModel(model),
        ),
      ).toEqual([]);
    });
  });
});

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
