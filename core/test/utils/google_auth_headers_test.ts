/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient, GoogleAuth} from 'google-auth-library';
import {describe, expect, it, vi} from 'vitest';
import {resolveAuthHeaders} from '../../src/utils/google_auth_headers.js';

/** A GoogleAuth whose client returns `headers` and `quotaProjectId`. */
function authReturning(
  headers: Record<string, string>,
  quotaProjectId?: string,
): GoogleAuth {
  const client = {
    getRequestHeaders: vi.fn().mockResolvedValue(new Headers(headers)),
    quotaProjectId,
  } as unknown as AuthClient;
  return {
    getClient: vi.fn().mockResolvedValue(client),
  } as unknown as GoogleAuth;
}

describe('resolveAuthHeaders', () => {
  it('returns the authorization header for the audience', async () => {
    const auth = authReturning({authorization: 'Bearer token'});
    await expect(
      resolveAuthHeaders(auth, 'https://example.googleapis.com'),
    ).resolves.toEqual({Authorization: 'Bearer token'});
  });

  it('mints the headers for the audience it is given', async () => {
    const auth = authReturning({authorization: 'Bearer token'});
    await resolveAuthHeaders(auth, 'https://example.googleapis.com');
    const client = await auth.getClient();
    expect(client.getRequestHeaders).toHaveBeenCalledWith(
      'https://example.googleapis.com',
    );
  });

  it('adds the quota project when the credentials name one', async () => {
    const auth = authReturning(
      {authorization: 'Bearer token'},
      'quota-project',
    );
    await expect(
      resolveAuthHeaders(auth, 'https://example.googleapis.com'),
    ).resolves.toEqual({
      'Authorization': 'Bearer token',
      'x-goog-user-project': 'quota-project',
    });
  });

  it('returns no headers when the credentials carry no authorization', async () => {
    const auth = authReturning({});
    await expect(
      resolveAuthHeaders(auth, 'https://example.googleapis.com'),
    ).resolves.toEqual({});
  });

  it('propagates a credentials failure', async () => {
    const auth = {
      getClient: vi.fn().mockRejectedValue(new Error('no ADC')),
    } as unknown as GoogleAuth;
    await expect(
      resolveAuthHeaders(auth, 'https://example.googleapis.com'),
    ).rejects.toThrow('no ADC');
  });
});
