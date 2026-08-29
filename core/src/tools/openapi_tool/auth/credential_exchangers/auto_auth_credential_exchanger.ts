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
import {OAuth2CredentialRefresher} from '../../../../auth/oauth2/oauth2_credential_refresher.js';
import {experimental} from '../../../../utils/experimental.js';
import {OAuth2BearerCredentialExchanger} from './oauth2_bearer_exchanger.js';
import {ServiceAccountCredentialExchanger} from './service_account_exchanger.js';

/**
 * Renews an expired access token.
 *
 * @param credential The credential to renew.
 * @param authScheme The scheme naming the token endpoint.
 * @returns The renewed credential, or the credential supplied when it needs no
 *   refresh, carries no refresh token, or the token request fails.
 */
async function refreshIfExpired(
  credential: AuthCredential,
  authScheme?: AuthScheme,
): Promise<AuthCredential> {
  // `OAuth2CredentialRefresher.refresh` warns when the credential carries no
  // refresh token, and most tool calls carry none.
  if (!credential.oauth2?.refreshToken) {
    return credential;
  }

  const refresher = new OAuth2CredentialRefresher();
  if (!(await refresher.isRefreshNeeded(credential))) {
    return credential;
  }

  return refresher.refresh(credential, authScheme);
}

/**
 * Builds an exchanger that obtains an OAuth2 access token, renews it once it
 * has expired, then wraps it as the HTTP bearer credential the OpenAPI layer
 * sends in the Authorization header.
 */
function createOAuth2Exchanger(): BaseCredentialExchanger {
  const tokenExchanger = new OAuth2CredentialExchanger();
  const bearerExchanger = new OAuth2BearerCredentialExchanger();

  return {
    async exchange(params) {
      const acquired = await tokenExchanger.exchange(params);
      // Every OAuth2 credential reaches the request through here, so this
      // covers the first call of a session as well as a stored credential.
      const refreshed = await refreshIfExpired(
        acquired.credential,
        params.authScheme,
      );
      const converted = await bearerExchanger.exchange({
        authScheme: params.authScheme,
        authCredential: refreshed,
      });

      return {
        // The bearer credential holds neither the refresh token nor the
        // expiry, so the OAuth2 data stays on the credential the caller
        // stores. A later call reads it back and refreshes the token.
        credential: {...refreshed, http: converted.credential.http},
        // The refresher returns the credential it was given, by reference,
        // when it did not reach the token endpoint.
        wasExchanged:
          acquired.wasExchanged || refreshed !== acquired.credential,
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
