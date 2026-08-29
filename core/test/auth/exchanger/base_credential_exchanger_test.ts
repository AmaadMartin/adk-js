/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialMissingError,
  AuthCredentialTypes,
  AuthScheme,
  BaseAuthCredentialExchanger,
  CredentialExchangeError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const AUTH_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'x-api-key',
};

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'some-key',
};

class UnimplementedExchanger extends BaseAuthCredentialExchanger {}

class MockAuthCredentialExchanger extends BaseAuthCredentialExchanger {
  override async exchangeCredential(
    _authScheme: AuthScheme,
    _authCredential?: AuthCredential,
  ): Promise<AuthCredential> {
    return {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'some-token'}},
    };
  }
}

class NoCredentialExchanger extends BaseAuthCredentialExchanger {
  override async exchangeCredential(
    _authScheme: AuthScheme,
    _authCredential?: AuthCredential,
  ): Promise<AuthCredential | undefined> {
    return undefined;
  }
}

/** The exchanger the developer guide shows. */
class ApiKeyExchanger extends BaseAuthCredentialExchanger {
  override async exchangeCredential(
    _authScheme: AuthScheme,
    authCredential?: AuthCredential,
  ): Promise<AuthCredential> {
    if (!authCredential) {
      throw new AuthCredentialMissingError(
        'authCredential is empty. Provide an API key credential.',
      );
    }
    return authCredential;
  }
}

describe('BaseAuthCredentialExchanger', () => {
  it('rejects when a subclass does not implement exchangeCredential', async () => {
    const exchanger = new UnimplementedExchanger();

    await expect(
      exchanger.exchangeCredential(AUTH_SCHEME, API_KEY_CREDENTIAL),
    ).rejects.toThrow('Subclasses must implement exchangeCredential.');
  });

  it('rejects when the credential is omitted', async () => {
    const exchanger = new UnimplementedExchanger();

    await expect(exchanger.exchangeCredential(AUTH_SCHEME)).rejects.toThrow(
      'Subclasses must implement exchangeCredential.',
    );
  });

  it('returns the credential an overriding subclass builds', async () => {
    const exchanger = new MockAuthCredentialExchanger();

    const credential = await exchanger.exchangeCredential(
      AUTH_SCHEME,
      API_KEY_CREDENTIAL,
    );

    expect(credential).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'some-token'}},
    });
  });

  it('accepts undefined as a result', async () => {
    const exchanger = new NoCredentialExchanger();

    await expect(
      exchanger.exchangeCredential(AUTH_SCHEME, API_KEY_CREDENTIAL),
    ).resolves.toBeUndefined();
  });

  it('lets a subclass reject a missing credential', async () => {
    const exchanger = new ApiKeyExchanger();

    await expect(exchanger.exchangeCredential(AUTH_SCHEME)).rejects.toThrow(
      AuthCredentialMissingError,
    );
    await expect(
      exchanger.exchangeCredential(AUTH_SCHEME, API_KEY_CREDENTIAL),
    ).resolves.toBe(API_KEY_CREDENTIAL);
  });
});

describe('AuthCredentialMissingError', () => {
  it('carries the message it was constructed with', () => {
    const error = new AuthCredentialMissingError('Test missing credential');

    expect(error.message).toBe('Test missing credential');
    expect(String(error)).toContain('Test missing credential');
  });

  it('is an Error but not a CredentialExchangeError', () => {
    const error = new AuthCredentialMissingError('Test missing credential');

    expect(error.name).toBe('AuthCredentialMissingError');
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CredentialExchangeError);
  });
});
