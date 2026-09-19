/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {resolveAuthHeaders} from '../../src/utils/google_auth_headers.js';

const AUDIENCE = 'https://example.googleapis.com';

let credentialHeaders: Record<string, string>;
let quotaProjectId: string | undefined;
let clientFailure: Error | undefined;

const getRequestHeaders = vi.fn();

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockImplementation(() => {
      if (clientFailure) {
        return Promise.reject(clientFailure);
      }
      return Promise.resolve({getRequestHeaders, quotaProjectId});
    }),
  })),
}));

beforeEach(() => {
  credentialHeaders = {};
  quotaProjectId = undefined;
  clientFailure = undefined;
  getRequestHeaders.mockImplementation(() =>
    Promise.resolve(new Headers(credentialHeaders)),
  );
});

describe('resolveAuthHeaders', () => {
  it('returns the authorization header the credentials mint', async () => {
    credentialHeaders = {authorization: 'Bearer token'};

    await expect(
      resolveAuthHeaders(new GoogleAuth(), AUDIENCE),
    ).resolves.toEqual({Authorization: 'Bearer token'});
  });

  it('mints the headers for the audience it is given', async () => {
    await resolveAuthHeaders(new GoogleAuth(), AUDIENCE);

    expect(getRequestHeaders).toHaveBeenCalledWith(AUDIENCE);
  });

  it('adds the quota project when the credentials name one', async () => {
    credentialHeaders = {authorization: 'Bearer token'};
    quotaProjectId = 'quota-project';

    await expect(
      resolveAuthHeaders(new GoogleAuth(), AUDIENCE),
    ).resolves.toEqual({
      'Authorization': 'Bearer token',
      'x-goog-user-project': 'quota-project',
    });
  });

  it('returns no headers when the credentials carry no authorization', async () => {
    await expect(
      resolveAuthHeaders(new GoogleAuth(), AUDIENCE),
    ).resolves.toEqual({});
  });

  it('propagates a credentials failure', async () => {
    clientFailure = new Error('no ADC');

    await expect(
      resolveAuthHeaders(new GoogleAuth(), AUDIENCE),
    ).rejects.toThrow('no ADC');
  });
});
