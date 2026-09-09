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
import {CredentialExchangerRegistry} from '../../../../auth/exchanger/credential_exchanger_registry.js';
import {OAuth2CredentialExchanger} from '../../../../auth/oauth2/oauth2_credential_exchanger.js';
import {experimental} from '../../../../utils/experimental.js';
import {ServiceAccountCredentialExchanger} from './service_account_exchanger.js';

const oauth2Exchanger = new OAuth2CredentialExchanger();

const DEFAULT_EXCHANGERS: Partial<
  Record<AuthCredentialTypes, BaseCredentialExchanger>
> = {
  [AuthCredentialTypes.OAUTH2]: oauth2Exchanger,
  [AuthCredentialTypes.OPEN_ID_CONNECT]: oauth2Exchanger,
  [AuthCredentialTypes.SERVICE_ACCOUNT]:
    new ServiceAccountCredentialExchanger(),
};

/**
 * Selects a credential exchanger from the credential's `authType`, then
 * delegates the exchange to it.
 *
 * The built-in exchangers map `OAUTH2` and `OPEN_ID_CONNECT` to
 * `OAuth2CredentialExchanger`, and `SERVICE_ACCOUNT` to
 * `ServiceAccountCredentialExchanger`. A credential of any other type comes
 * back unchanged.
 */
@experimental
export class AutoAuthCredentialExchanger implements BaseCredentialExchanger {
  /**
   * @param customExchangers - Exchangers that take priority over the built-in
   *   ones. Registering a credential type that has no built-in adds it;
   *   registering one that has a built-in replaces it.
   */
  constructor(
    private readonly customExchangers = new CredentialExchangerRegistry(),
  ) {}

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

    const exchanger =
      this.customExchangers.getExchanger(authCredential.authType) ??
      DEFAULT_EXCHANGERS[authCredential.authType];

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
