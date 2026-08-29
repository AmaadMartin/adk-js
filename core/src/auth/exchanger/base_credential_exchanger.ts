/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../auth_credential.js';
import {AuthScheme} from '../auth_schemes.js';

/**
 * Base exception for credential exchange errors.
 */
export class CredentialExchangeError extends Error {}

/**
 * Result of a credential exchange.
 */
export interface ExchangeResult {
  credential: AuthCredential;
  wasExchanged: boolean;
}

/**
 * Base interface for credential exchangers.
 *
 * Credential exchangers are responsible for exchanging credentials from
 * one format or scheme to another.
 */
export interface BaseCredentialExchanger {
  /**
   * Exchange credential if needed.
   *
   * @param params.authCredential - The credential to exchange.
   * @param params.authScheme - The authentication scheme (optional, some exchangers don't need it).
   * @returns The exchanged credential.
   * @throws CredentialExchangeError: If credential exchange fails.
   */

  exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult>;
}

/**
 * Error raised when a required authentication credential is missing.
 *
 * This error is separate from {@link CredentialExchangeError}: a caller that
 * catches an exchange failure does not catch a missing credential.
 */
export class AuthCredentialMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthCredentialMissingError';
  }
}

/**
 * Base class for authentication credential exchangers.
 *
 * A subclass turns the credential an OpenAPI tool was configured with into a
 * credential the request can send.
 */
export abstract class BaseAuthCredentialExchanger {
  /**
   * Exchanges the provided authentication credential for a usable
   * token/credential.
   *
   * @param _authScheme The security scheme.
   * @param _authCredential The authentication credential.
   * @returns The exchanged credential, the original credential when the scheme
   *     needs no exchange, or `undefined` when no request-ready credential
   *     exists yet.
   * @throws {Error} If a subclass does not implement this method.
   */
  async exchangeCredential(
    _authScheme: AuthScheme,
    _authCredential?: AuthCredential,
  ): Promise<AuthCredential | undefined> {
    throw new Error('Subclasses must implement exchangeCredential.');
  }
}
