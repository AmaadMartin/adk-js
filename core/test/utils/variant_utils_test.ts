/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleLLMVariant} from '@google/adk';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {logger} from '../../src/utils/logger.js';
import {getGoogleLlmVariant} from '../../src/utils/variant_utils.js';

describe('variant_utils', () => {
  describe('getGoogleLlmVariant', () => {
    const originalEnv = process.env;
    let warnSpy: MockInstance<typeof logger.warn>;

    beforeEach(() => {
      process.env = {...originalEnv};
      delete process.env['GOOGLE_GENAI_USE_ENTERPRISE'];
      delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
      warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      process.env = originalEnv;
      vi.restoreAllMocks();
    });

    it('should return GEMINI_API by default (when env var is not set)', () => {
      delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.GEMINI_API);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should return VERTEX_AI when GOOGLE_GENAI_USE_VERTEXAI is "true"', () => {
      process.env = {...originalEnv, 'GOOGLE_GENAI_USE_VERTEXAI': 'true'};
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.VERTEX_AI);
    });

    it('should return VERTEX_AI when GOOGLE_GENAI_USE_VERTEXAI is "1"', () => {
      process.env = {...originalEnv, 'GOOGLE_GENAI_USE_VERTEXAI': '1'};
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.VERTEX_AI);
    });

    it('should return GEMINI_API when GOOGLE_GENAI_USE_VERTEXAI is "false"', () => {
      process.env = {...originalEnv, 'GOOGLE_GENAI_USE_VERTEXAI': 'false'};
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.GEMINI_API);
    });

    it('should return VERTEX_AI when GOOGLE_GENAI_USE_ENTERPRISE is "true"', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = 'true';
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.VERTEX_AI);
    });

    it('should return VERTEX_AI when GOOGLE_GENAI_USE_ENTERPRISE is "1"', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = '1';
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.VERTEX_AI);
    });

    it('should return GEMINI_API when GOOGLE_GENAI_USE_ENTERPRISE is "false"', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = 'false';
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.GEMINI_API);
    });

    it('should prefer a falsy GOOGLE_GENAI_USE_ENTERPRISE over the legacy variable', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = '0';
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.GEMINI_API);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should prefer a truthy GOOGLE_GENAI_USE_ENTERPRISE over the legacy variable', () => {
      process.env['GOOGLE_GENAI_USE_ENTERPRISE'] = 'true';
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'false';
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.VERTEX_AI);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should warn when falling back to GOOGLE_GENAI_USE_VERTEXAI', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      expect(getGoogleLlmVariant()).toBe(GoogleLLMVariant.VERTEX_AI);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('GOOGLE_GENAI_USE_VERTEXAI is deprecated'),
      );
    });
  });
});
