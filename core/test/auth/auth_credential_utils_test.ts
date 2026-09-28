/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential, AuthCredentialTypes, toAuthHeaders} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('toAuthHeaders', () => {
  it('renders a bearer HTTP credential as an Authorization header', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Bearer', credentials: {token: 'tok-123'}},
    };

    expect(toAuthHeaders(credential)).toEqual({
      Authorization: 'Bearer tok-123',
    });
  });

  it('keeps a non-Bearer scheme name in the header value', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Basic', credentials: {token: 'dXNlcjpwdw=='}},
    };

    expect(toAuthHeaders(credential)).toEqual({
      Authorization: 'Basic dXNlcjpwdw==',
    });
  });

  it('copies additionalHeaders verbatim', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: '',
        credentials: {},
        additionalHeaders: {
          'X-Custom-Auth': 'tok-456',
          'X-GOOG-API-KEY': 'tok-456',
        },
      },
    };

    expect(toAuthHeaders(credential)).toEqual({
      'X-Custom-Auth': 'tok-456',
      'X-GOOG-API-KEY': 'tok-456',
    });
  });

  it('lets additionalHeaders win over the derived Authorization header', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'Bearer',
        credentials: {token: 'derived'},
        additionalHeaders: {Authorization: 'Bearer explicit'},
      },
    };

    expect(toAuthHeaders(credential)).toEqual({
      Authorization: 'Bearer explicit',
    });
  });

  it('returns no headers for an apiKey credential', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'key-789',
    };

    const headers = toAuthHeaders(credential);
    expect(headers).toEqual({});
    expect(headers['Authorization']).toBeUndefined();
  });

  it('returns no headers for an HTTP credential that carries no token', () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Bearer', credentials: {}},
    };

    const headers = toAuthHeaders(credential);
    expect(headers).toEqual({});
    expect(headers['Authorization']).toBeUndefined();
  });
});
