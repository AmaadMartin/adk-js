/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential, AuthCredentialTypes, AuthScheme} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
// `buildAuthHeaders` is deliberately internal (adk-python keeps it in a private
// `_auth_headers` module), so it is imported by path rather than from the
// package barrel.
import {buildAuthHeaders} from '../../src/auth/auth_headers.js';
import {logger} from '../../src/utils/logger.js';

const apiKeyInHeader: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
};

const apiKeyInQuery: AuthScheme = {
  type: 'apiKey',
  in: 'query',
  name: 'api_key',
};

describe('buildAuthHeaders', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined without a credential', () => {
    expect(buildAuthHeaders(undefined)).toBeUndefined();
  });

  it('returns a bearer header for an OAuth2 access token', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'oauth-token'},
    };

    expect(buildAuthHeaders(credential)).toEqual({
      Authorization: 'Bearer oauth-token',
    });
  });

  it('returns undefined for an OAuth2 credential with no access token', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'id', clientSecret: 'secret'},
    };

    expect(buildAuthHeaders(credential)).toBeUndefined();
  });

  it('returns a bearer header for an HTTP bearer credential', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'http-token'}},
    };

    expect(buildAuthHeaders(credential)).toEqual({
      Authorization: 'Bearer http-token',
    });
  });

  it('returns undefined for an HTTP bearer credential with no token', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {}},
    };

    expect(buildAuthHeaders(credential)).toBeUndefined();
  });

  it('base64-encodes a basic credential', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'basic',
        credentials: {username: 'testuser', password: 'testpass'},
      },
    };

    expect(buildAuthHeaders(credential)).toEqual({
      Authorization: 'Basic dGVzdHVzZXI6dGVzdHBhc3M=',
    });
  });

  it('returns undefined for a basic credential with no password', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'basic', credentials: {username: 'testuser'}},
    };

    expect(buildAuthHeaders(credential)).toBeUndefined();
  });

  it('preserves the spelling of a non-standard HTTP scheme', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Custom-Scheme', credentials: {token: 'custom-token'}},
    };

    expect(buildAuthHeaders(credential)).toEqual({
      Authorization: 'Custom-Scheme custom-token',
    });
  });

  it('returns undefined for a non-standard HTTP scheme with no token', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Custom-Scheme', credentials: {}},
    };

    expect(buildAuthHeaders(credential)).toBeUndefined();
  });

  it('merges additional headers on top of a bearer header', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'bearer',
        credentials: {token: 'http-token'},
        additionalHeaders: {'X-Extra': 'extra-value'},
      },
    };

    expect(buildAuthHeaders(credential)).toEqual({
      Authorization: 'Bearer http-token',
      'X-Extra': 'extra-value',
    });
  });

  it('returns additional headers even when no Authorization header is produced', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'bearer',
        credentials: {},
        additionalHeaders: {'X-Goog-Api-Key': 'api-key'},
      },
    };

    expect(buildAuthHeaders(credential)).toEqual({
      'X-Goog-Api-Key': 'api-key',
    });
  });

  it('names the API key header from the scheme', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret-api-key',
    };

    expect(buildAuthHeaders(credential, apiKeyInHeader)).toEqual({
      'X-API-Key': 'secret-api-key',
    });
  });

  it('refuses an API key outside the header and never logs the key', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret-api-key',
    };

    expect(buildAuthHeaders(credential, apiKeyInQuery)).toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain(
      'Only header-based API key authentication is supported',
    );
    expect(message).toContain('query');
    expect(message).not.toContain('secret-api-key');
  });

  it('returns undefined for an API key with no scheme', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret-api-key',
    };

    expect(buildAuthHeaders(credential)).toBeUndefined();
  });

  it('returns undefined for an API key paired with a non-API-key scheme', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret-api-key',
    };
    const httpScheme: AuthScheme = {type: 'http', scheme: 'bearer'};

    expect(buildAuthHeaders(credential, httpScheme)).toBeUndefined();
  });

  it('warns and returns undefined for a service account credential', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: {useDefaultCredential: true},
    };

    expect(buildAuthHeaders(credential)).toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('service account');
  });

  it('returns undefined for a credential carrying nothing usable', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
    };

    expect(buildAuthHeaders(credential)).toBeUndefined();
  });
});
