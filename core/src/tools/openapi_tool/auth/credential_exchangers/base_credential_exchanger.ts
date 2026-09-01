/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../../../../auth/auth_credential.js';
import {AuthScheme} from '../../../../auth/auth_schemes.js';
import {experimental} from '../../../../utils/experimental.js';

/**
 * Raised when a scheme needs an authentication credential that the caller did
 * not supply.
 */
export class AuthCredentialMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthCredentialMissingError';
  }
}

/**
 * Base class for the OpenAPI toolset's credential exchangers.
 *
 * This is a separate hierarchy from the asynchronous `BaseCredentialExchanger`
 * interface in `core/src/auth/exchanger/`. adk-python keeps the two apart in
 * the same way, so neither one replaces the other.
 */
@experimental
export class BaseAuthCredentialExchanger {
  /**
   * Exchanges an authentication credential for one a request can use.
   *
   * The default implementation throws. A subclass overrides it.
   *
   * @param _authScheme The security scheme the credential belongs to.
   * @param _authCredential The credential to exchange.
   * @returns An updated credential holding the fetched secret. A scheme that
   *     needs no exchange, such as an API key, may return the original
   *     credential.
   * @throws Error If a subclass does not override this method.
   */
  exchangeCredential(
    _authScheme: AuthScheme,
    _authCredential?: AuthCredential,
  ): AuthCredential | undefined {
    throw new Error('Subclasses must implement exchangeCredential.');
  }
}
