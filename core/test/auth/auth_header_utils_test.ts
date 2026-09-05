/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredentialTypes, AuthScheme} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {buildAuthHeaders} from '../../src/auth/auth_header_utils.js';

const API_KEY_HEADER_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Api-Key',
};

describe('buildAuthHeaders', () => {
  it('returns nothing without a credential', () => {
    expect(buildAuthHeaders(API_KEY_HEADER_SCHEME)).toEqual({});
  });

  it('presents an http bearer token', () => {
    expect(
      buildAuthHeaders(undefined, {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Bearer', credentials: {token: 'abc'}},
      }),
    ).toEqual({'Authorization': 'Bearer abc'});
  });

  it('keeps the scheme name the server declared', () => {
    expect(
      buildAuthHeaders(undefined, {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'Negotiate', credentials: {token: 'abc'}},
      }),
    ).toEqual({'Authorization': 'Negotiate abc'});
  });

  it('encodes basic credentials', () => {
    expect(
      buildAuthHeaders(undefined, {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'basic',
          credentials: {username: 'user', password: 'pass'},
        },
      }),
    ).toEqual({'Authorization': `Basic ${btoa('user:pass')}`});
  });

  it('presents no basic header when the password is missing', () => {
    expect(
      buildAuthHeaders(undefined, {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'basic', credentials: {username: 'user'}},
      }),
    ).toEqual({});
  });

  it('presents no basic header when the username is missing', () => {
    expect(
      buildAuthHeaders(undefined, {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'basic', credentials: {password: 'pass'}},
      }),
    ).toEqual({});
  });

  it('presents no header for an http credential with no token', () => {
    expect(
      buildAuthHeaders(undefined, {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {}},
      }),
    ).toEqual({});
  });

  it('presents no header for an http credential with no http block', () => {
    expect(
      buildAuthHeaders(undefined, {authType: AuthCredentialTypes.HTTP}),
    ).toEqual({});
  });

  it('puts an api key in the header its scheme names', () => {
    expect(
      buildAuthHeaders(API_KEY_HEADER_SCHEME, {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret',
      }),
    ).toEqual({'X-Api-Key': 'secret'});
  });

  it('presents no api key when its scheme puts it in the query', () => {
    expect(
      buildAuthHeaders(
        {type: 'apiKey', in: 'query', name: 'key'},
        {authType: AuthCredentialTypes.API_KEY, apiKey: 'secret'},
      ),
    ).toEqual({});
  });

  it('presents no api key without a scheme to place it', () => {
    expect(
      buildAuthHeaders(undefined, {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret',
      }),
    ).toEqual({});
  });

  it('presents no api key when the credential carries none', () => {
    expect(
      buildAuthHeaders(API_KEY_HEADER_SCHEME, {
        authType: AuthCredentialTypes.API_KEY,
      }),
    ).toEqual({});
  });

  it('presents an exchanged oauth2 access token', () => {
    expect(
      buildAuthHeaders(undefined, {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'token'},
      }),
    ).toEqual({'Authorization': 'Bearer token'});
  });

  it('presents an exchanged OpenID Connect access token', () => {
    expect(
      buildAuthHeaders(undefined, {
        authType: AuthCredentialTypes.OPEN_ID_CONNECT,
        oauth2: {accessToken: 'token'},
      }),
    ).toEqual({'Authorization': 'Bearer token'});
  });

  it('presents nothing for an oauth2 credential awaiting its exchange', () => {
    expect(
      buildAuthHeaders(undefined, {
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {clientId: 'id', clientSecret: 'secret'},
      }),
    ).toEqual({});
  });

  it('presents nothing for a credential type it cannot place', () => {
    expect(
      buildAuthHeaders(undefined, {
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {scopes: []},
      }),
    ).toEqual({});
  });

  it('presents nothing for a Google Cloud auth provider binding', () => {
    expect(
      buildAuthHeaders({
        type: 'gcpAuthProviderScheme',
        name: 'projects/p/locations/l/authProviders/ap-1',
      }),
    ).toEqual({});
  });
});
