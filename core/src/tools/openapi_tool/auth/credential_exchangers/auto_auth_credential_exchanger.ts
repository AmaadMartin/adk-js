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
 * Automatically selects the appropriate credential exchanger based on the auth scheme.
 * Ported from Python implementation.
 */
@experimental
export class AutoAuthCredentialExchanger implements BaseCredentialExchanger {
  private exchangers: Map<AuthCredentialTypes, BaseCredentialExchanger> =
    new Map();

  constructor() {
    const oauth2Exchanger = createOAuth2Exchanger();
    this.exchangers.set(AuthCredentialTypes.OAUTH2, oauth2Exchanger);
    this.exchangers.set(AuthCredentialTypes.OPEN_ID_CONNECT, oauth2Exchanger);
    this.exchangers.set(
      AuthCredentialTypes.SERVICE_ACCOUNT,
      new ServiceAccountCredentialExchanger(),
    );
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
