/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
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

class MockAuthCredentialExchanger extends BaseAuthCredentialExchanger {
  override exchangeCredential(
    _authScheme: AuthScheme,
    authCredential?: AuthCredential,
  ): AuthCredential {
    if (!authCredential) {
      throw new AuthCredentialMissingError('Auth credential is required.');
    }
    return authCredential;
  }
}

describe('BaseAuthCredentialExchanger', () => {
  const mockAuthScheme: AuthScheme = {
    type: 'apiKey',
    in: 'header',
    name: 'X-API-Key',
  };

  const mockAuthCredential: AuthCredential = {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: 'test-api-key',
  };

  it('throws an error when exchangeCredential is not implemented by subclass', () => {
    const exchanger = new BaseAuthCredentialExchanger();
    expect(() =>
      exchanger.exchangeCredential(mockAuthScheme, mockAuthCredential),
    ).toThrow('Subclasses must implement exchange_credential.');
    expect(() =>
      exchanger.exchange_credential(mockAuthScheme, mockAuthCredential),
    ).toThrow('Subclasses must implement exchange_credential.');
  });

  it('exchanges credential in a concrete subclass', () => {
    const exchanger = new MockAuthCredentialExchanger();
    const result = exchanger.exchangeCredential(
      mockAuthScheme,
      mockAuthCredential,
    );
    expect(result).toEqual(mockAuthCredential);
    expect(exchanger.exchange_credential(mockAuthScheme, mockAuthCredential)).toEqual(
      mockAuthCredential,
    );
  });

  it('properly initializes AuthCredentialMissingError with message', () => {
    const errorMessage = 'Missing authentication credentials';
    const error = new AuthCredentialMissingError(errorMessage);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AuthCredentialMissingError);
    expect(error.message).toBe(errorMessage);
    expect(error.name).toBe('AuthCredentialMissingError');
  });
});
