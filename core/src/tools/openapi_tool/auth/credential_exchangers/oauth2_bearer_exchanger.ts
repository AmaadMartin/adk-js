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
 * Converts an OAuth2 or OpenID Connect credential into an HTTP bearer
 * credential that the OpenAPI tool layer can send in the Authorization header.
 * Ported from Python implementation.
 */
@experimental
export class OAuth2BearerCredentialExchanger implements BaseCredentialExchanger {
  /**
   * Converts the credential into an HTTP bearer credential.
   *
   * Keeping the token fresh belongs to the caller:
   * `AutoAuthCredentialExchanger` refreshes an expired credential before it
   * calls this exchanger.
   *
   * @param params.authScheme The OAuth2 or OpenID Connect scheme.
   * @param params.authCredential The credential to convert.
   * @throws CredentialExchangeError If the scheme or the credential is invalid.
   */
  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    checkSchemeCredentialType(params);

    // A credential the caller refreshed carries both blocks, so the OAuth2
    // access token wins over an `http` block holding the token it replaced.
    // Python reads `http` first, where a credential never carries both.
    const {oauth2} = params.authCredential;
    if (!oauth2?.accessToken) {
      // An HTTP credential is already in the form the header needs, and a
      // credential with no access token has nothing to wrap.
      return {credential: params.authCredential, wasExchanged: false};
    }

    return {
      credential: generateAuthToken(oauth2.accessToken),
      // Wrapping a token the credential already holds costs no round trip.
      // `ToolAuthHandler` persists on this flag, so reporting an exchange here
      // would copy a static client secret into the session store.
      wasExchanged: false,
    };
  }
}

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
  // refresh token, and most tool calls carry none. It runs every other check
  // itself, and returns this credential by reference when it skips the
  // refresh.
  if (!credential.oauth2?.refreshToken) {
    return credential;
  }

  return new OAuth2CredentialRefresher().refresh(credential, authScheme);
}

/**
 * Obtains an OAuth2 access token, renews it once it has expired, then wraps it
 * as the HTTP bearer credential the OpenAPI layer sends in the Authorization
 * header.
 */
@experimental
export class OAuth2RefreshingBearerExchanger implements BaseCredentialExchanger {
  private readonly tokenExchanger = new OAuth2CredentialExchanger();
  private readonly bearerExchanger = new OAuth2BearerCredentialExchanger();

  /**
   * Produces the bearer credential a request carries.
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
    // Every OAuth2 credential reaches the request through here, so this covers
    // the first call of a session as well as a stored credential.
    const refreshed = await refreshIfExpired(
      acquired.credential,
      params.authScheme,
    );
    const converted = await this.bearerExchanger.exchange({
      authScheme: params.authScheme,
      authCredential: refreshed,
    });

    return {
      // The bearer credential holds neither the refresh token nor the expiry,
      // so the OAuth2 data stays on the credential the caller stores. A later
      // call reads it back and refreshes the token.
      credential: {...refreshed, http: converted.credential.http},
      // The refresher returns the credential it was given, by reference, when
      // it did not reach the token endpoint.
      wasExchanged: acquired.wasExchanged || refreshed !== acquired.credential,
    };
  }
}
