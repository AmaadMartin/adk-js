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
import {OAuth2BearerCredentialExchanger} from './oauth2_bearer_exchanger.js';
import {ServiceAccountCredentialExchanger} from './service_account_exchanger.js';

/**
 * Builds an exchanger that obtains an OAuth2 access token, then converts it
 * into the HTTP bearer credential that the OpenAPI layer sends in the
 * Authorization header.
 *
 * The two exchangers are built once per caller rather than at module load, so
 * importing this file does not emit their experimental warnings.
 */
function createOAuth2Exchanger(): BaseCredentialExchanger {
  const tokenExchanger = new OAuth2CredentialExchanger();
  const bearerExchanger = new OAuth2BearerCredentialExchanger();

  return {
    async exchange(params) {
      const acquired = await tokenExchanger.exchange(params);
      const converted = await bearerExchanger.exchange({
        authScheme: params.authScheme,
        authCredential: acquired.credential,
      });

      return {
        credential: converted.credential,
        wasExchanged: acquired.wasExchanged || converted.wasExchanged,
      };
    },
  };
}

/**
 * Selects a credential exchanger from the credential's `authType`, then
 * delegates the exchange to it.
 *
 * The built-ins map `OAUTH2` and `OPEN_ID_CONNECT` to
 * {@link createOAuth2Exchanger}, which returns an HTTP bearer credential, and
 * `SERVICE_ACCOUNT` to {@link ServiceAccountCredentialExchanger}. A credential
 * of any other type comes back unchanged.
 *
 * @example
 * ```ts
 * // Add an exchanger for a type that has no built-in.
 * const exchanger = new AutoAuthCredentialExchanger(
 *   new Map([[AuthCredentialTypes.API_KEY, myApiKeyExchanger]]),
 * );
 * ```
 */
@experimental
export class AutoAuthCredentialExchanger implements BaseCredentialExchanger {
  /**
   * The exchanger for each credential type. Public so a caller can inspect an
   * entry, or replace one after construction.
   */
  readonly exchangers = new Map<AuthCredentialTypes, BaseCredentialExchanger>();

  /**
   * @param customExchangers - Exchangers merged over the built-ins. An entry
   *   for a type that has no built-in adds it; an entry for a type that has
   *   one replaces it. The constructor copies the entries, so a later change
   *   to this map does not reach the instance.
   */
  constructor(
    customExchangers?: ReadonlyMap<
      AuthCredentialTypes,
      BaseCredentialExchanger
    >,
  ) {
    const oauth2Exchanger = createOAuth2Exchanger();
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

  exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult>;
  exchange(params: {
    authScheme?: AuthScheme;
    authCredential?: AuthCredential | null;
  }): Promise<ExchangeResult | null>;
  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential?: AuthCredential | null;
  }): Promise<ExchangeResult | null> {
    const {authCredential, authScheme} = params;

    if (!authCredential) {
      return null;
    }

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
