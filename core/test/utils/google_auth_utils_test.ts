/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  GoogleAuthCredentialSource,
  RequestHeaders,
  getGoogleAuthHeaders,
} from '../../src/utils/google_auth_utils.js';

const URL = 'https://example.googleapis.com';

/**
 * Builds an auth source whose client returns `requestHeaders`, mirroring what
 * `google-auth-library` hands back.
 */
function authSource(options: {
  requestHeaders?: RequestHeaders;
  accessToken?: string;
  clientQuotaProjectId?: string;
  authQuotaProjectId?: string;
}): GoogleAuthCredentialSource {
  return {
    getClient: async () => ({
      getRequestHeaders: async () => options.requestHeaders ?? {},
      credentials: {access_token: options.accessToken},
      quotaProjectId: options.clientQuotaProjectId,
    }),
    quotaProjectId: options.authQuotaProjectId,
  };
}

function failingAuthSource(failure: unknown): GoogleAuthCredentialSource {
  return {
    getClient: () => Promise.reject(failure),
  };
}

describe('getGoogleAuthHeaders', () => {
  it('returns the Authorization header from the client', async () => {
    const headers = await getGoogleAuthHeaders(
      authSource({
        requestHeaders: {'Authorization': 'Bearer fake-token'},
        clientQuotaProjectId: 'quota-project-123',
      }),
      URL,
    );

    expect(headers['Authorization']).toBe('Bearer fake-token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['x-goog-user-project']).toBe('quota-project-123');
  });

  it('matches the Authorization header case-insensitively', async () => {
    const headers = await getGoogleAuthHeaders(
      authSource({requestHeaders: {'authorization': 'Bearer fake-token'}}),
      URL,
    );

    expect(headers['Authorization']).toBe('Bearer fake-token');
  });

  it('reads a Headers instance', async () => {
    const headers = await getGoogleAuthHeaders(
      authSource({
        requestHeaders: new Headers({'Authorization': 'Bearer fake-token'}),
      }),
      URL,
    );

    expect(headers['Authorization']).toBe('Bearer fake-token');
  });

  it('ignores a Headers instance that carries no Authorization', async () => {
    const headers = await getGoogleAuthHeaders(
      authSource({requestHeaders: new Headers({'X-Other': 'value'})}),
      URL,
    );

    expect(headers['Authorization']).toBeUndefined();
  });

  it('falls back to the access token when no header is present', async () => {
    const headers = await getGoogleAuthHeaders(
      authSource({accessToken: 'fallback-token'}),
      URL,
    );

    expect(headers['Authorization']).toBe('Bearer fallback-token');
  });

  it('omits Authorization when there is no token at all', async () => {
    const headers = await getGoogleAuthHeaders(authSource({}), URL);

    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('ignores a non-string header value', async () => {
    const headers = await getGoogleAuthHeaders(
      authSource({requestHeaders: {'Authorization': 42}}),
      URL,
    );

    expect(headers['Authorization']).toBeUndefined();
  });

  it('falls back to the quota project on the auth source', async () => {
    const headers = await getGoogleAuthHeaders(
      authSource({authQuotaProjectId: 'quota-project-auth'}),
      URL,
    );

    expect(headers['x-goog-user-project']).toBe('quota-project-auth');
  });

  it('omits the quota project header when none is configured', async () => {
    const headers = await getGoogleAuthHeaders(authSource({}), URL);

    expect(headers['x-goog-user-project']).toBeUndefined();
  });

  it('reports a credential refresh failure', async () => {
    await expect(
      getGoogleAuthHeaders(failingAuthSource(new Error('Auth error')), URL),
    ).rejects.toThrow('Failed to refresh Google Cloud credentials: Auth error');
  });

  it('reports a non-Error refresh failure', async () => {
    await expect(
      getGoogleAuthHeaders(failingAuthSource('boom'), URL),
    ).rejects.toThrow('Failed to refresh Google Cloud credentials: boom');
  });
});
