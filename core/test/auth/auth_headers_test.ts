/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredentialTypes, AuthScheme} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it, vi} from 'vitest';
import {AuthCredential} from '../../src/auth/auth_credential.js';
import {buildAuthHeaders} from '../../src/auth/auth_headers.js';
import {logger} from '../../src/utils/logger.js';

const API_KEY_HEADER_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
};

const API_KEY_QUERY_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'query',
  name: 'api_key',
};

const BEARER_SCHEME: OpenAPIV3.HttpSecurityScheme = {
  type: 'http',
  scheme: 'bearer',
};

describe('buildAuthHeaders', () => {
  it('returns undefined without a credential', () => {
    expect(buildAuthHeaders(undefined, API_KEY_HEADER_SCHEME)).toBeUndefined();
  });

  it('returns undefined for a credential it cannot express', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
    };
    expect(buildAuthHeaders(credential)).toBeUndefined();
  });

  it('carries an OAuth2 access token as a bearer header', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'tok-1'},
    };
    expect(buildAuthHeaders(credential)).toEqual({
      Authorization: 'Bearer tok-1',
    });
  });

  it('sends nothing for an OAuth2 credential with no access token', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'id', clientSecret: 'secret'},
    };
    expect(buildAuthHeaders(credential)).toBeUndefined();
  });

  it('carries an HTTP bearer token', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Bearer', credentials: {token: 'tok-2'}},
    };
    expect(buildAuthHeaders(credential, BEARER_SCHEME)).toEqual({
      Authorization: 'Bearer tok-2',
    });
  });

  it('sends nothing for an HTTP bearer scheme with no token', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {}},
    };
    expect(buildAuthHeaders(credential, BEARER_SCHEME)).toBeUndefined();
  });

  it('base64-encodes HTTP basic credentials', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'basic',
        credentials: {username: 'alice', password: 'p@ss'},
      },
    };
    expect(buildAuthHeaders(credential)).toEqual({
      Authorization: `Basic ${btoa('alice:p@ss')}`,
    });
  });

  it('sends nothing for HTTP basic with no password', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'basic', credentials: {username: 'alice'}},
    };
    expect(buildAuthHeaders(credential)).toBeUndefined();
  });

  it('keeps the scheme name for a non-bearer HTTP scheme with a token', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Digest', credentials: {token: 'tok-3'}},
    };
    expect(buildAuthHeaders(credential)).toEqual({
      Authorization: 'Digest tok-3',
    });
  });

  it('merges additional headers over the scheme headers', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'bearer',
        credentials: {token: 'tok-4'},
        additionalHeaders: {'X-Trace': 'abc'},
      },
    };
    expect(buildAuthHeaders(credential)).toEqual({
      Authorization: 'Bearer tok-4',
      'X-Trace': 'abc',
    });
  });

  it('returns additional headers even when no scheme header applies', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'basic',
        credentials: {},
        additionalHeaders: {'X-Trace': 'abc'},
      },
    };
    expect(buildAuthHeaders(credential)).toEqual({'X-Trace': 'abc'});
  });

  it('names the API key header from the scheme', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'key-1',
    };
    expect(buildAuthHeaders(credential, API_KEY_HEADER_SCHEME)).toEqual({
      'X-API-Key': 'key-1',
    });
  });

  it('warns and sends nothing for an API key placed in the query', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'key-1',
    };
    expect(buildAuthHeaders(credential, API_KEY_QUERY_SCHEME)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Only header-based API key authentication'),
    );
    warn.mockRestore();
  });

  it('warns and sends nothing for an API key with no apiKey scheme', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'key-1',
    };
    expect(buildAuthHeaders(credential, BEARER_SCHEME)).toBeUndefined();
    expect(buildAuthHeaders(credential)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
