/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../../../auth/auth_credential.js';
import {AuthScheme} from '../../../../auth/auth_schemes.js';
import {
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';
import {OAuth2CredentialExchanger} from '../../../../auth/oauth2/oauth2_credential_exchanger.js';
import {experimental} from '../../../../utils/experimental.js';
import {ServiceAccountCredentialExchanger} from './service_account_exchanger.js';

/**
 * Builds the built-in exchanger table. This is a factory rather than a shared
 * constant so that two instances never share one table.
 */
function createDefaultExchangers(): Partial<
  Record<AuthCredentialTypes, BaseCredentialExchanger>
> {
  const oauth2Exchanger = new OAuth2CredentialExchanger();

  return {
    [AuthCredentialTypes.OAUTH2]: oauth2Exchanger,
    [AuthCredentialTypes.OPEN_ID_CONNECT]: oauth2Exchanger,
    [AuthCredentialTypes.SERVICE_ACCOUNT]:
      new ServiceAccountCredentialExchanger(),
  };
}

/**
 * Selects a credential exchanger from the credential's `authType`, then
 * delegates the exchange to it.
 *
 * The built-in table maps `OAUTH2` and `OPEN_ID_CONNECT` to
 * {@link OAuth2CredentialExchanger}, and `SERVICE_ACCOUNT` to
 * {@link ServiceAccountCredentialExchanger}. A credential of any other type
 * comes back unchanged.
 *
 * @example Common case
 * ```ts
 * const exchanger = new AutoAuthCredentialExchanger();
 * const {credential} = await exchanger.exchange({
 *   authScheme,
 *   authCredential: serviceAccountCredential,
 * });
 * ```
 *
 * @example Add an exchanger for a type with no built-in
 * ```ts
 * const exchanger = new AutoAuthCredentialExchanger({
 *   [AuthCredentialTypes.API_KEY]: new MyApiKeyExchanger(),
 * });
 * ```
 *
 * @example Override a built-in
 * ```ts
 * const exchanger = new AutoAuthCredentialExchanger({
 *   [AuthCredentialTypes.OAUTH2]: new MyOAuth2Exchanger(),
 * });
 * ```
 */
@experimental
export class AutoAuthCredentialExchanger implements BaseCredentialExchanger {
  private readonly exchangers: Partial<
    Record<AuthCredentialTypes, BaseCredentialExchanger>
  >;

  /**
   * @param customExchangers - Exchangers that add to the built-in table. An
   *   entry whose credential type already has a built-in replaces it.
   */
  constructor(
    customExchangers: Partial<
      Record<AuthCredentialTypes, BaseCredentialExchanger>
    > = {},
  ) {
    this.exchangers = {...createDefaultExchangers(), ...customExchangers};
  }

  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const {authCredential, authScheme} = params;

    if (!authCredential) {
      throw new CredentialExchangeError(
        'authCredential is required for credential exchange.',
      );
    }

    const exchanger = this.exchangers[authCredential.authType];

    if (!exchanger) {
      // If no exchanger found, return the original credential as not exchanged
      return {
        credential: authCredential,
        wasExchanged: false,
      };
    }

    return exchanger.exchange({authScheme, authCredential});
  }
}
