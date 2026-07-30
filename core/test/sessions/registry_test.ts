/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemorySessionService,
  VertexAiSessionService,
  getSessionServiceFromUri,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('Registry', () => {
  describe('getSessionServiceFromUri', () => {
    beforeEach(() => {
      // VertexAiSessionService falls back to express mode when these are set,
      // which would mask whether the URI was parsed at all.
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', '');
      vi.stubEnv('GOOGLE_API_KEY', '');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('should return InMemorySessionService for "memory://" uri', () => {
      const service = getSessionServiceFromUri('memory://');
      expect(service).to.be.instanceOf(InMemorySessionService);
    });

    it('should throw error for unsupported uri', () => {
      expect(() =>
        getSessionServiceFromUri('unsupported://localhost:5432/mydb'),
      ).to.throw(
        'Unsupported session service URI: unsupported://localhost:5432/mydb',
      );
    });

    it('should configure VertexAiSessionService from a project/location uri', () => {
      const service = getSessionServiceFromUri(
        'vertexai://projects/my-project/locations/us-central1',
      );
      expect(service).toBeInstanceOf(VertexAiSessionService);
    });

    it('should configure VertexAiSessionService from a full resource uri', () => {
      const service = getSessionServiceFromUri(
        'vertexai://projects/my-project/locations/us-central1/reasoningEngines/1234567890',
      );
      expect(service).toBeInstanceOf(VertexAiSessionService);
    });

    it('should throw for a malformed vertexai:// uri instead of ignoring it', () => {
      expect(() =>
        getSessionServiceFromUri('vertexai://projects//locations/us-central1'),
      ).toThrow(
        'Invalid Vertex AI session service URI: vertexai://projects//locations/us-central1',
      );
    });

    it('should leave bare "vertexai://" to the express-mode fallback', () => {
      expect(() => getSessionServiceFromUri('vertexai://')).toThrow(
        'Either (Project ID and Location) or an expressModeApiKey is required.',
      );
    });
  });
});
