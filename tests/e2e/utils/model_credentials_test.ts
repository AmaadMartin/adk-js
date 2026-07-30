/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {hasModelCredentials} from './model_credentials.js';

const CREDENTIAL_ENV_VARS = [
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_GENAI_API_KEY',
  'GEMINI_API_KEY',
];

describe('hasModelCredentials', () => {
  beforeEach(() => {
    // Blank every variable the helper reads so the result never depends on the
    // developer's real environment.
    for (const name of CREDENTIAL_ENV_VARS) {
      vi.stubEnv(name, '');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns false when nothing is set', () => {
    expect(hasModelCredentials()).toBe(false);
  });

  it('returns true for GEMINI_API_KEY alone', () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    expect(hasModelCredentials()).toBe(true);
  });

  it('returns true for GOOGLE_GENAI_API_KEY alone', () => {
    vi.stubEnv('GOOGLE_GENAI_API_KEY', 'test-key');
    expect(hasModelCredentials()).toBe(true);
  });

  it('returns false for GOOGLE_CLOUD_PROJECT alone', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    expect(hasModelCredentials()).toBe(false);
  });

  it('returns false for project and location without GOOGLE_GENAI_USE_VERTEXAI', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    expect(hasModelCredentials()).toBe(false);
  });

  it.each(['true', '1', 'TRUE'])(
    'returns true for GOOGLE_GENAI_USE_VERTEXAI=%s with project and location',
    (useVertexAi) => {
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', useVertexAi);
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
      expect(hasModelCredentials()).toBe(true);
    },
  );

  it('returns false in Vertex mode without a location', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    expect(hasModelCredentials()).toBe(false);
  });

  it('returns false in Vertex mode without a project', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    expect(hasModelCredentials()).toBe(false);
  });

  it.each(['yes', '0'])(
    'falls through to the API key branch for GOOGLE_GENAI_USE_VERTEXAI=%s',
    (useVertexAi) => {
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', useVertexAi);
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
      expect(hasModelCredentials()).toBe(false);
    },
  );

  it('returns false when an API key is set but Vertex mode lacks a project', () => {
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'us-central1');
    expect(hasModelCredentials()).toBe(false);
  });
});
