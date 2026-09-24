/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {
  CLOUD_PLATFORM_SCOPE,
  parseServiceAccountJson,
  resolveGoogleAuthClient,
} from '../../src/utils/google_auth_utils.js';

/** The options every `GoogleAuth` in a test was constructed with. */
const authState = vi.hoisted(() => ({
  options: [] as Array<{credentials?: unknown; scopes?: string[]}>,
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(options: {credentials?: unknown; scopes?: string[]}) {
      authState.options.push(options);
    }
    async getClient() {
      return {getAccessToken: async () => ({token: 'token'})};
    }
  },
}));

const KEYFILE = JSON.stringify({
  type: 'service_account',
  client_email: 'test@example.com',
  private_key: 'key',
  token_uri: 'https://example.test/token',
  universe_domain: 'example.test',
});

describe('parseServiceAccountJson', () => {
  it('keeps every field of the keyfile', () => {
    expect(parseServiceAccountJson(KEYFILE)).toEqual({
      type: 'service_account',
      client_email: 'test@example.com',
      private_key: 'key',
      token_uri: 'https://example.test/token',
      universe_domain: 'example.test',
    });
  });

  it('reports material that is not JSON, and keeps the parse error', () => {
    let rejection: unknown;
    try {
      parseServiceAccountJson('not json');
    } catch (error: unknown) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe(
      'Invalid service account JSON: Unexpected token \'o\', "not json" is ' +
        'not valid JSON',
    );
    expect((rejection as Error).cause).toBeInstanceOf(SyntaxError);
  });
});

describe('resolveGoogleAuthClient', () => {
  it('hands the whole keyfile to the credential', async () => {
    authState.options.length = 0;

    await resolveGoogleAuthClient(parseServiceAccountJson(KEYFILE));

    expect(authState.options).toEqual([
      {
        credentials: JSON.parse(KEYFILE) as unknown,
        scopes: [CLOUD_PLATFORM_SCOPE],
      },
    ]);
  });

  it('falls back to Application Default Credentials', async () => {
    authState.options.length = 0;

    await resolveGoogleAuthClient();

    expect(authState.options).toEqual([
      {credentials: undefined, scopes: [CLOUD_PLATFORM_SCOPE]},
    ]);
  });
});
