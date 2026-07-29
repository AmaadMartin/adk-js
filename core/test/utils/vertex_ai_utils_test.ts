/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SDK_VERSION} from '@google-cloud/vertexai/build/src/genai/client.js';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  createAgentEnginesClient,
  createExpressModeApiClient,
  getExpressModeApiKey,
} from '../../src/utils/vertex_ai_utils.js';

const FAKE_API_KEY = 'fake-express-key';

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

  describe('createExpressModeApiClient', () => {
    it('should authenticate with the key instead of a project and location', () => {
      const client = createExpressModeApiClient(FAKE_API_KEY);

      expect(client.getApiKey()).toBe(FAKE_API_KEY);
      expect(client.getProject()).toBeUndefined();
      expect(client.getLocation()).toBeUndefined();
      expect(client.isVertexAI()).toBe(true);
    });

    it('should send the key as the x-goog-api-key header', async () => {
      const headers =
        await createExpressModeApiClient(FAKE_API_KEY).getAuthHeaders();

      expect(headers.get('x-goog-api-key')).toBe(FAKE_API_KEY);
    });

    it('should report the same user agent as the vendor client', () => {
      const client = createExpressModeApiClient(FAKE_API_KEY);

      expect(client.clientOptions.userAgentExtra).toBe(
        `vertex-genai-modules/${SDK_VERSION}`,
      );
    });
  });

  describe('createAgentEnginesClient', () => {
    it('should build a client from an express mode key alone', () => {
      const client = createAgentEnginesClient({
        expressModeApiKey: FAKE_API_KEY,
      });

      expect(client.sessions).toBeDefined();
      expect(client.memories).toBeDefined();
    });

    it('should build a client from a project and location', () => {
      const client = createAgentEnginesClient({
        projectId: 'test-project',
        location: 'us-central1',
      });

      expect(client.sessions).toBeDefined();
      expect(client.memories).toBeDefined();
    });

    it('should throw when given neither a key nor a project and location', () => {
      expect(() => createAgentEnginesClient({})).toThrow(
        'Authentication is not set up.',
      );
    });
  });
});
