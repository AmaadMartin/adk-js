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
import {OAuth2CredentialRefresher} from '../../../../auth/oauth2/oauth2_credential_refresher.js';
import {experimental} from '../../../../utils/experimental.js';

const OAUTH2_SCHEME_TYPES = ['oauth2', 'openIdConnect'];

/**
 * Validates that the pair can produce a bearer token.
 *
 * @param params The scheme and credential to validate.
 * @throws CredentialExchangeError If the credential is missing, the scheme is
 *   neither OAuth2 nor OpenID Connect, or the credential configures neither
 *   oauth2 nor http.
 */
export function checkSchemeCredentialType(params: {
  authScheme?: AuthScheme;
  authCredential?: AuthCredential;
}): void {
  const {authScheme, authCredential} = params;

  if (!authCredential) {
    throw new CredentialExchangeError(
      'auth_credential is empty. Please create AuthCredential using OAuth2Auth.',
    );
  }

  if (!authScheme || !OAUTH2_SCHEME_TYPES.includes(authScheme.type)) {
    throw new CredentialExchangeError(
      `Invalid security scheme, expect openIdConnect or oauth2 auth scheme, but got ${authScheme?.type}`,
    );
  }

  if (!authCredential.oauth2 && !authCredential.http) {
    throw new CredentialExchangeError(
      'auth_credential is not configured with oauth2. Please create AuthCredential and set OAuth2Auth.',
    );
  }
}

/**
 * Wraps an access token as an HTTP bearer credential.
 *
 * @param accessToken The token to send in the Authorization header.
 * @returns A new HTTP bearer credential.
 */
export function generateAuthToken(accessToken: string): AuthCredential {
  return {
    authType: AuthCredentialTypes.HTTP,
    http: {
      scheme: 'bearer',
      credentials: {token: accessToken},
    },
  };
}

/**
 * Obtains an OAuth2 access token, renews it once it has expired, then wraps it
 * as the HTTP bearer credential the OpenAPI layer sends in the Authorization
 * header.
 */
@experimental
export class OAuth2RefreshingBearerExchanger implements BaseCredentialExchanger {
  private readonly tokenExchanger = new OAuth2CredentialExchanger();

  /**
   * Produces the bearer credential a request carries.
   *
   * Every OAuth2 credential reaches the request through here, so this covers
   * the first call of a session as well as a stored credential.
   *
   * @param params.authScheme The OAuth2 or OpenID Connect scheme.
   * @param params.authCredential The credential to exchange.
   * @throws CredentialExchangeError If the scheme or the credential is invalid.
   */
  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const acquired = await this.tokenExchanger.exchange(params);
    // `OAuth2CredentialRefresher.refresh` warns when the credential carries no
    // refresh token, and most tool calls carry none. It runs every other check
    // itself, and returns its argument by reference when it skips the refresh.
    const refreshed = acquired.credential.oauth2?.refreshToken
      ? await new OAuth2CredentialRefresher().refresh(
          acquired.credential,
          params.authScheme,
        )
      : acquired.credential;

    checkSchemeCredentialType({
      authScheme: params.authScheme,
      authCredential: refreshed,
    });
    // A refreshed credential carries both blocks, so the OAuth2 access token
    // wins over an `http` block holding the token it replaced. A credential
    // with no access token is either already an HTTP one or has nothing to
    // wrap.
    const token = refreshed.oauth2?.accessToken;

    return {
      // The bearer credential holds neither the refresh token nor the expiry,
      // so the OAuth2 data stays on the credential the caller stores. A later
      // call reads it back and refreshes the token.
      credential: {
        ...refreshed,
        http: token ? generateAuthToken(token).http : refreshed.http,
      },
      // The refresher returns the credential it was given, by reference, when
      // it did not reach the token endpoint.
      wasExchanged: acquired.wasExchanged || refreshed !== acquired.credential,
    };
  }
}
