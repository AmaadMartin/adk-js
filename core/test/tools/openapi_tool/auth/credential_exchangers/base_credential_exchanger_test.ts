/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the OpenAPI toolset's synchronous `BaseAuthCredentialExchanger`. That
 * is a different hierarchy from the asynchronous `BaseCredentialExchanger`
 * interface in `core/src/auth/exchanger/`, which adk-python also keeps
 * separately. Neither one replaces the other.
 */

import {describe, expect, it} from 'vitest';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../../../src/auth/auth_credential.js';
import {AuthScheme} from '../../../../../src/auth/auth_schemes.js';
import {
  AuthCredentialMissingError,
  BaseAuthCredentialExchanger,
} from '../../../../../src/tools/openapi_tool/auth/credential_exchangers/base_credential_exchanger.js';

const AUTH_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'x-api-key',
};

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'some-token',
};

/**
 * Turns the API key of an incoming credential into a bearer token, and reports
 * a credential it cannot exchange. Stands in for the real subclasses, which
 * reach the network.
 */
class ApiKeyToBearerExchanger extends BaseAuthCredentialExchanger {
  override exchangeCredential(
    authScheme: AuthScheme,
    authCredential?: AuthCredential,
  ): AuthCredential {
    if (!authCredential?.apiKey) {
      throw new AuthCredentialMissingError(
        `Scheme ${authScheme.type} needs an API key.`,
      );
    }
    return {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: authCredential.apiKey}},
    };
  }
}

describe('BaseAuthCredentialExchanger', () => {
  it('throws until a subclass overrides exchangeCredential', () => {
    const exchanger = new BaseAuthCredentialExchanger();

    expect(() =>
      exchanger.exchangeCredential(AUTH_SCHEME, API_KEY_CREDENTIAL),
    ).toThrow('Subclasses must implement exchangeCredential.');
    // The credential is optional, so omitting it still reaches the same throw.
    expect(() => exchanger.exchangeCredential(AUTH_SCHEME)).toThrow(
      'Subclasses must implement exchangeCredential.',
    );
  });

  it('lets a subclass return an exchanged credential', () => {
    const exchanger = new ApiKeyToBearerExchanger();

    expect(
      exchanger.exchangeCredential(AUTH_SCHEME, API_KEY_CREDENTIAL),
    ).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'some-token'}},
    });
  });

  it('lets a subclass report a missing credential', () => {
    const exchanger = new ApiKeyToBearerExchanger();

    expect(() => exchanger.exchangeCredential(AUTH_SCHEME)).toThrow(
      AuthCredentialMissingError,
    );
    expect(() => exchanger.exchangeCredential(AUTH_SCHEME)).toThrow(
      'Scheme apiKey needs an API key.',
    );
  });
});

describe('AuthCredentialMissingError', () => {
  it('carries the supplied message', () => {
    const error = new AuthCredentialMissingError('Test missing credential');

    expect(error.message).toBe('Test missing credential');
    expect(error.name).toBe('AuthCredentialMissingError');
    expect(error).toBeInstanceOf(AuthCredentialMissingError);
    expect(error).toBeInstanceOf(Error);
  });
});
