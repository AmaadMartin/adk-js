/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../../../../auth/auth_credential.js';
import {AuthScheme} from '../../../../auth/auth_schemes.js';
import {
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';

export {BaseCredentialExchanger, CredentialExchangeError, ExchangeResult};

/**
 * Exception raised when required authentication credentials are missing.
 */
export class AuthCredentialMissingError extends Error {
  override message: string;

  constructor(message: string) {
    super(message);
    this.name = 'AuthCredentialMissingError';
    this.message = message;
    Object.setPrototypeOf(this, AuthCredentialMissingError.prototype);
  }
}

/**
 * Base class for authentication credential exchangers.
 */
export class BaseAuthCredentialExchanger {
  /**
   * Exchanges the provided authentication credential for a usable token/credential.
   *
   * @param authScheme The security scheme.
   * @param authCredential The authentication credential.
   * @returns An updated AuthCredential object containing the fetched credential.
   *   For simple schemes like API key, it may return the original credential
   *   if no exchange is needed.
   * @throws Error If the method is not implemented by a subclass.
   */
  exchangeCredential(
    authScheme: AuthScheme,
    authCredential?: AuthCredential,
  ): AuthCredential | Promise<AuthCredential> {
    if (
      this.exchange_credential !==
      BaseAuthCredentialExchanger.prototype.exchange_credential
    ) {
      return this.exchange_credential(authScheme, authCredential);
    }
    throw new Error('Subclasses must implement exchange_credential.');
  }

  /**
   * Snake_case alias for {@link exchangeCredential}.
   */
  exchange_credential(
    authScheme: AuthScheme,
    authCredential?: AuthCredential,
  ): AuthCredential | Promise<AuthCredential> {
    if (
      this.exchangeCredential !==
      BaseAuthCredentialExchanger.prototype.exchangeCredential
    ) {
      return this.exchangeCredential(authScheme, authCredential);
    }
    throw new Error('Subclasses must implement exchange_credential.');
  }
}
