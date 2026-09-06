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
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';
import {OAuth2CredentialExchanger} from '../../../../auth/oauth2/oauth2_credential_exchanger.js';
import {experimental} from '../../../../utils/experimental.js';
import {ServiceAccountCredentialExchanger} from './service_account_exchanger.js';

/**
 * Selects a credential exchanger from the credential's `authType`, then
 * delegates the exchange to it.
 *
 * The built-ins map `OAUTH2` and `OPEN_ID_CONNECT` to
 * {@link OAuth2CredentialExchanger}, and `SERVICE_ACCOUNT` to
 * {@link ServiceAccountCredentialExchanger}. A credential of any other type
 * comes back unchanged.
 */
@experimental
export class AutoAuthCredentialExchanger implements BaseCredentialExchanger {
  /**
   * The exchanger for each credential type.
   *
   * This is configuration, not internal state: adk-python publishes the same
   * `exchangers` attribute, and a caller replaces an entry on a live instance
   * to route one credential type elsewhere. `readonly` fixes the map itself,
   * not its entries.
   */
  readonly exchangers = new Map<AuthCredentialTypes, BaseCredentialExchanger>();

  /**
   * @param customExchangers - Exchangers merged over the built-ins. An entry
   *   for a type that has no built-in adds it; an entry for a type that has
   *   one replaces it. The constructor copies the entries, so mutating the
   *   caller's map afterwards does not reach the instance.
   */
  constructor(
    customExchangers?: ReadonlyMap<
      AuthCredentialTypes,
      BaseCredentialExchanger
    >,
  ) {
    const oauth2Exchanger = new OAuth2CredentialExchanger();
    this.exchangers.set(AuthCredentialTypes.OAUTH2, oauth2Exchanger);
    this.exchangers.set(AuthCredentialTypes.OPEN_ID_CONNECT, oauth2Exchanger);
    this.exchangers.set(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      new ServiceAccountCredentialExchanger(),
    );

    for (const [authType, exchanger] of customExchangers ?? []) {
      this.exchangers.set(authType, exchanger);
    }
  }

  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const {authCredential, authScheme} = params;

    const exchanger = this.exchangers.get(authCredential.authType);

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
