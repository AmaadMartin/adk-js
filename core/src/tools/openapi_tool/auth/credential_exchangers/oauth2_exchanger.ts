/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  OAuth2Auth,
} from '../../../../auth/auth_credential.js';
import {AuthScheme} from '../../../../auth/auth_schemes.js';
import {
  BaseCredentialExchanger,
  CredentialExchangeError,
  ExchangeResult,
} from '../../../../auth/exchanger/base_credential_exchanger.js';
import {
  createOAuth2TokenRequestBody,
  fetchOAuth2Tokens,
  getTokenEndpoint,
  isTokenExpired,
} from '../../../../auth/oauth2/oauth2_utils.js';
import {experimental} from '../../../../utils/experimental.js';
import {logger} from '../../../../utils/logger.js';

const OAUTH2_SCHEME_TYPES = ['oauth2', 'openIdConnect'];

/** A scheme and credential pair that passed {@link checkSchemeCredentialType}. */
interface ValidatedOAuth2Params {
  authScheme: AuthScheme;
  authCredential: AuthCredential;
}

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
}): asserts params is ValidatedOAuth2Params {
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
 * Exchanges a refresh token for a new access token.
 *
 * A refresh failure is not fatal: the caller keeps the existing token.
 *
 * @param authScheme The scheme that names the token endpoint.
 * @param oauth2 The credential holding the client identity.
 * @param refreshToken The refresh token to send.
 * @returns The refreshed access token, or undefined when the refresh cannot
 *   run or fails.
 */
async function refreshAccessToken(
  authScheme: AuthScheme,
  oauth2: OAuth2Auth,
  refreshToken: string,
): Promise<string | undefined> {
  const tokenEndpoint = getTokenEndpoint(authScheme);
  if (!tokenEndpoint || !oauth2.clientId || !oauth2.clientSecret) {
    logger.warn('Could not create OAuth2 session for token refresh');
    return undefined;
  }

  try {
    const tokens = await fetchOAuth2Tokens(
      tokenEndpoint,
      createOAuth2TokenRequestBody({
        grantType: 'refresh_token',
        clientId: oauth2.clientId,
        clientSecret: oauth2.clientSecret,
        refreshToken,
      }),
    );
    logger.debug('Successfully refreshed OAuth2 tokens');
    return tokens.accessToken;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
      `Failed to refresh OAuth2 tokens, falling back to existing token: ${reason}`,
    );
    return undefined;
  }
}

/**
 * Converts an OAuth2 or OpenID Connect credential into an HTTP bearer
 * credential that the OpenAPI tool layer can send in the Authorization header.
 * Ported from Python implementation.
 */
@experimental
export class OAuth2CredentialExchanger implements BaseCredentialExchanger {
  /**
   * Converts the credential into an HTTP bearer credential.
   *
   * @param authScheme The OAuth2 or OpenID Connect scheme.
   * @param authCredential The credential to convert.
   * @returns The bearer credential, the input credential when it already
   *   carries an HTTP credential, or undefined when it has no access token.
   * @throws CredentialExchangeError If the scheme or the credential is invalid.
   */
  async exchangeCredential(
    authScheme?: AuthScheme,
    authCredential?: AuthCredential,
  ): Promise<AuthCredential | undefined> {
    const params = {authScheme, authCredential};
    checkSchemeCredentialType(params);

    // An HTTP credential is already in the form the header needs.
    if (params.authCredential.http) {
      return params.authCredential;
    }

    const {oauth2} = params.authCredential;
    if (!oauth2?.accessToken) {
      return undefined;
    }

    const {refreshToken} = oauth2;
    const refreshed =
      refreshToken && isTokenExpired(oauth2)
        ? await refreshAccessToken(params.authScheme, oauth2, refreshToken)
        : undefined;

    return generateAuthToken(refreshed ?? oauth2.accessToken);
  }

  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const credential = await this.exchangeCredential(
      params.authScheme,
      params.authCredential,
    );

    if (!credential || credential === params.authCredential) {
      return {credential: params.authCredential, wasExchanged: false};
    }

    return {credential, wasExchanged: true};
  }
}
