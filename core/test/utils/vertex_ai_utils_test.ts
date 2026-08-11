/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  getExpressModeApiKey,
  parseAgentEngineResourceName,
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

  describe('parseAgentEngineResourceName', () => {
    it('should split a full resource name into its three components', () => {
      expect(
        parseAgentEngineResourceName(
          'projects/my-proj/locations/us-central1/reasoningEngines/123',
        ),
      ).toEqual({
        projectId: 'my-proj',
        location: 'us-central1',
        agentEngineId: '123',
      });
    });

    it('should preserve the case of every segment', () => {
      expect(
        parseAgentEngineResourceName(
          'projects/My-Proj/locations/US-central1/reasoningEngines/Abc',
        ),
      ).toEqual({
        projectId: 'My-Proj',
        location: 'US-central1',
        agentEngineId: 'Abc',
      });
    });

    it('should return undefined for a name that is missing a segment', () => {
      expect(
        parseAgentEngineResourceName('projects/p/reasoningEngines/123'),
      ).toBeUndefined();
    });

    it('should return undefined for a name with a trailing slash', () => {
      expect(
        parseAgentEngineResourceName(
          'projects/p/locations/l/reasoningEngines/123/',
        ),
      ).toBeUndefined();
    });

    it('should return undefined for a bare resource id', () => {
      expect(parseAgentEngineResourceName('123')).toBeUndefined();
    });
  });
});
