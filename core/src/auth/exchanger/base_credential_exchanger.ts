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
 * {@link CredentialExchangeError} reports that an exchange failed. This error
 * reports that there was nothing to exchange. The two are unrelated classes, so
 * a `catch` on one does not catch the other. Keep the credential itself out of
 * the message: an error string reaches logs and bug reports.
 */
export class AuthCredentialMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthCredentialMissingError';
  }
}

/**
 * Base class for authentication credential exchangers used by the OpenAPI tool
 * auth layer.
 *
 * This is the legacy exchange contract, distinct from
 * {@link BaseCredentialExchanger} above: it takes the scheme and credential as
 * positional arguments with the scheme required, and returns the credential
 * directly rather than an {@link ExchangeResult}.
 */
export abstract class BaseAuthCredentialExchanger {
  /**
   * Exchanges the provided credential for a usable token or credential.
   *
   * @param authScheme The security scheme. Required.
   * @param authCredential The authentication credential, if one is available.
   * @returns The updated credential, or `undefined` when the exchange cannot
   *   yet produce a request-ready credential. Simple schemes such as API key
   *   may return the original credential when no exchange is needed.
   */
  abstract exchangeCredential(
    authScheme: AuthScheme,
    authCredential?: AuthCredential,
  ): Promise<AuthCredential | undefined>;
}
