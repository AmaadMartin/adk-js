/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  getExpressModeApiKey,
  parseReasoningEngineName,
} from '../../src/utils/vertex_ai_utils.js';

describe('vertex_ai_utils', () => {
  describe('getExpressModeApiKey', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = {...originalEnv};
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should throw when both project and expressModeApiKey are provided', () => {
      expect(() =>
        getExpressModeApiKey('my-project', undefined, 'my-api-key'),
      ).toThrow('Cannot specify project or location and expressModeApiKey.');
    });

    it('should throw when both location and expressModeApiKey are provided', () => {
      expect(() =>
        getExpressModeApiKey(undefined, 'us-central1', 'my-api-key'),
      ).toThrow('Cannot specify project or location and expressModeApiKey.');
    });

    it('should throw when project, location, and expressModeApiKey are all provided', () => {
      expect(() =>
        getExpressModeApiKey('my-project', 'us-central1', 'my-api-key'),
      ).toThrow();
    });

    it('should return undefined when GOOGLE_GENAI_USE_VERTEXAI is not set', () => {
      delete process.env['GOOGLE_GENAI_USE_VERTEXAI'];
      const result = getExpressModeApiKey();
      expect(result).toBeUndefined();
    });

    it('should return undefined when GOOGLE_GENAI_USE_VERTEXAI is false', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'false';
      const result = getExpressModeApiKey();
      expect(result).toBeUndefined();
    });

    it('should return expressModeApiKey when GOOGLE_GENAI_USE_VERTEXAI is true', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      const result = getExpressModeApiKey(undefined, undefined, 'my-api-key');
      expect(result).toBe('my-api-key');
    });

    it('should return GOOGLE_API_KEY from env when GOOGLE_GENAI_USE_VERTEXAI is true and no key provided', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      process.env['GOOGLE_API_KEY'] = 'env-api-key';
      const result = getExpressModeApiKey();
      expect(result).toBe('env-api-key');
    });

    it('should return undefined when GOOGLE_GENAI_USE_VERTEXAI is true but no key available', () => {
      process.env['GOOGLE_GENAI_USE_VERTEXAI'] = 'true';
      delete process.env['GOOGLE_API_KEY'];
      const result = getExpressModeApiKey();
      expect(result).toBeUndefined();
    });
  });

  describe('parseReasoningEngineName', () => {
    it('should parse a fully-qualified resource name', () => {
      expect(
        parseReasoningEngineName(
          'projects/my-project/locations/us-central1/reasoningEngines/999',
        ),
      ).toEqual({
        projectId: 'my-project',
        location: 'us-central1',
        reasoningEngineId: '999',
      });
    });

    it('should allow underscores and hyphens in the project id', () => {
      expect(
        parseReasoningEngineName(
          'projects/my_project-1/locations/us-central1/reasoningEngines/12345',
        ),
      ).toEqual({
        projectId: 'my_project-1',
        location: 'us-central1',
        reasoningEngineId: '12345',
      });
    });

    it.each([
      ['a bare reasoning engine id', '12345'],
      ['an arbitrary string', 'invalid'],
      ['an empty string', ''],
      [
        'a non-numeric engine id',
        'projects/p/locations/l/reasoningEngines/abc',
      ],
      [
        'a sandbox environment resource name',
        'projects/p/locations/l/reasoningEngines/123/sandboxEnvironments/456',
      ],
      [
        'a name with a leading prefix',
        'prefix/projects/p/locations/l/reasoningEngines/123',
      ],
      [
        'a name with a trailing slash',
        'projects/p/locations/l/reasoningEngines/123/',
      ],
      [
        'a name with an empty project',
        'projects//locations/l/reasoningEngines/123',
      ],
    ])('should return undefined for %s', (_description, name) => {
      expect(parseReasoningEngineName(name)).toBeUndefined();
    });
  });
});
