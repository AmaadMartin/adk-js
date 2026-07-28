/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {describe, expect, it} from 'vitest';
import {getGoogleCloudAuthHeaders} from '../../src/utils/google_cloud_auth.js';

interface FakeAuthOptions {
  getClient?: () => Promise<unknown>;
  requestHeaders?: Record<string, string>;
  credentials?: {access_token?: string};
  clientQuotaProjectId?: string;
  authQuotaProjectId?: string;
}

function fakeAuth(options: FakeAuthOptions = {}): GoogleAuth {
  return {
    getClient:
      options.getClient ??
      (async () => ({
        getRequestHeaders: async () => options.requestHeaders ?? {},
        credentials: options.credentials ?? {},
        quotaProjectId: options.clientQuotaProjectId,
      })),
    quotaProjectId: options.authQuotaProjectId,
  } as unknown as GoogleAuth;
}

const URL = 'https://aiplatform.googleapis.com';

describe('utils/google_cloud_auth', () => {
  it('extracts the Authorization header and sets JSON content type', async () => {
    const headers = await getGoogleCloudAuthHeaders(
      fakeAuth({requestHeaders: {Authorization: 'Bearer fake-token'}}),
      URL,
    );
    expect(headers['Authorization']).toBe('Bearer fake-token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['x-goog-user-project']).toBeUndefined();
  });

  it('finds a lowercase authorization header', async () => {
    const headers = await getGoogleCloudAuthHeaders(
      fakeAuth({requestHeaders: {authorization: 'Bearer lower-token'}}),
      URL,
    );
    expect(headers['Authorization']).toBe('Bearer lower-token');
  });

  it('falls back to the client access token when no header is present', async () => {
    const headers = await getGoogleCloudAuthHeaders(
      fakeAuth({
        requestHeaders: {},
        credentials: {access_token: 'creds-token'},
      }),
      URL,
    );
    expect(headers['Authorization']).toBe('Bearer creds-token');
  });

  it('omits Authorization when no token is available', async () => {
    const headers = await getGoogleCloudAuthHeaders(
      fakeAuth({requestHeaders: {}, credentials: {}}),
      URL,
    );
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('attaches x-goog-user-project from the client quota project', async () => {
    const headers = await getGoogleCloudAuthHeaders(
      fakeAuth({clientQuotaProjectId: 'client-quota'}),
      URL,
    );
    expect(headers['x-goog-user-project']).toBe('client-quota');
  });

  it('falls back to the auth quota project id', async () => {
    const headers = await getGoogleCloudAuthHeaders(
      fakeAuth({
        clientQuotaProjectId: undefined,
        authQuotaProjectId: 'auth-quota',
      }),
      URL,
    );
    expect(headers['x-goog-user-project']).toBe('auth-quota');
  });

  it('wraps an Error auth failure with a descriptive message', async () => {
    await expect(
      getGoogleCloudAuthHeaders(
        fakeAuth({
          getClient: async () => {
            throw new Error('ADC not found');
          },
        }),
        URL,
      ),
    ).rejects.toThrow(
      'Failed to refresh Google Cloud credentials: ADC not found',
    );
  });

  it('stringifies a non-Error auth failure', async () => {
    await expect(
      getGoogleCloudAuthHeaders(
        fakeAuth({
          getClient: async () => {
            throw 'string failure';
          },
        }),
        URL,
      ),
    ).rejects.toThrow(
      'Failed to refresh Google Cloud credentials: string failure',
    );
  });
});
