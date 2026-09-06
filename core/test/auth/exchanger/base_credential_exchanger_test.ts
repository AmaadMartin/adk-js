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
  name: 'x-api-key',
  in: 'header',
};

const AUTH_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'some-key',
};

const EXCHANGED_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'exchanged-key',
};

class MockAuthCredentialExchanger extends BaseAuthCredentialExchanger {
  override async exchangeCredential(
    _authScheme: AuthScheme,
    _authCredential?: AuthCredential,
  ): Promise<AuthCredential | undefined> {
    return EXCHANGED_CREDENTIAL;
  }
}

class EmptyAuthCredentialExchanger extends BaseAuthCredentialExchanger {
  override async exchangeCredential(
    _authScheme: AuthScheme,
    _authCredential?: AuthCredential,
  ): Promise<AuthCredential | undefined> {
    return undefined;
  }
}

describe('AuthCredentialMissingError', () => {
  it('carries the message it was constructed with', () => {
    const error = new AuthCredentialMissingError('Test missing credential');

    expect(error.message).toBe('Test missing credential');
    expect(String(error)).toContain('Test missing credential');
  });

  it('is an Error and is not a CredentialExchangeError', () => {
    const error = new AuthCredentialMissingError('Test missing credential');

    expect(error.name).toBe('AuthCredentialMissingError');
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CredentialExchangeError);
  });
});

describe('BaseAuthCredentialExchanger', () => {
  it('accepts the scheme alone, without a credential', async () => {
    const exchanger: BaseAuthCredentialExchanger =
      new MockAuthCredentialExchanger();

    await expect(exchanger.exchangeCredential(AUTH_SCHEME)).resolves.toBe(
      EXCHANGED_CREDENTIAL,
    );
  });

  it('lets a subclass override the exchange', async () => {
    const exchanger = new MockAuthCredentialExchanger();

    await expect(
      exchanger.exchangeCredential(AUTH_SCHEME, AUTH_CREDENTIAL),
    ).resolves.toBe(EXCHANGED_CREDENTIAL);
  });

  it('lets a subclass resolve to undefined', async () => {
    const exchanger = new EmptyAuthCredentialExchanger();

    await expect(
      exchanger.exchangeCredential(AUTH_SCHEME, AUTH_CREDENTIAL),
    ).resolves.toBeUndefined();
  });
});
