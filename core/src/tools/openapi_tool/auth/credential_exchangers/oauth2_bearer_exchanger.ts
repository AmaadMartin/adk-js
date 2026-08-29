/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../../../../auth/auth_credential.js';
import {AuthScheme} from '../../../../auth/auth_schemes.js';
import {
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';
import {OAuth2CredentialExchanger} from '../../../../auth/oauth2/oauth2_credential_exchanger.js';
import {OAuth2CredentialRefresher} from '../../../../auth/oauth2/oauth2_credential_refresher.js';
import {experimental} from '../../../../utils/experimental.js';

/**
 * Obtains an OAuth2 access token, renews an expired one, then wraps it as the
 * HTTP bearer credential the OpenAPI layer sends in the Authorization header.
 */
@experimental
export class OAuth2RefreshingBearerExchanger implements BaseCredentialExchanger {
  /**
   * @throws CredentialExchangeError If the scheme is neither OAuth2 nor OpenID
   *   Connect, or the credential configures neither oauth2 nor http.
   */
  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const {authScheme, authCredential} = params;

    if (authScheme?.type !== 'oauth2' && authScheme?.type !== 'openIdConnect') {
      throw new CredentialExchangeError(
        `Invalid security scheme, expect openIdConnect or oauth2 auth scheme, but got ${authScheme?.type}`,
      );
    }

    if (!authCredential.oauth2) {
      if (!authCredential.http) {
        throw new CredentialExchangeError(
          'auth_credential is not configured with oauth2. Please create AuthCredential and set OAuth2Auth.',
        );
      }
      // A bearer token the tool's owner already holds has nothing to acquire,
      // and the acquisition delegate rejects it for the client it lacks.
      return {credential: authCredential, wasExchanged: false};
    }

    const acquired = await new OAuth2CredentialExchanger().exchange(params);
    const refreshed = await new OAuth2CredentialRefresher().refresh(
      acquired.credential,
      authScheme,
    );
    const token = refreshed.oauth2?.accessToken;

    return {
      // The OAuth2 data stays on the credential the caller stores, so a later
      // call can refresh the token the bearer block does not carry.
      credential: {
        ...refreshed,
        http: token ? {scheme: 'bearer', credentials: {token}} : refreshed.http,
      },
      // refresh() returns its input by reference unless the endpoint answered.
      wasExchanged: acquired.wasExchanged || refreshed !== acquired.credential,
    };
  }
}
