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
import {OAuth2CredentialRefresher} from '../../../../auth/oauth2/oauth2_credential_refresher.js';
import {experimental} from '../../../../utils/experimental.js';

const OAUTH2_SCHEME_TYPES = ['oauth2', 'openIdConnect'];

/**
 * Throws when the scheme/credential pair cannot be converted to a bearer token.
 *
 * @param authScheme The security scheme the credential belongs to.
 * @param authCredential The credential to convert.
 * @throws CredentialExchangeError If the pair is not an OAuth2 or OpenID
 *   Connect scheme with a matching credential.
 */
export function checkSchemeCredentialType(
  authScheme: AuthScheme | undefined,
  authCredential: AuthCredential,
): void {
  if (!authScheme || !OAUTH2_SCHEME_TYPES.includes(authScheme.type)) {
    throw new CredentialExchangeError(
      `Invalid security scheme, expected 'oauth2' or 'openIdConnect' auth scheme, but got ${authScheme?.type}`,
    );
  }

  if (!authCredential.oauth2 && !authCredential.http) {
    throw new CredentialExchangeError(
      'authCredential is not configured with oauth2. Please set oauth2 on the AuthCredential.',
    );
  }
}

/**
 * Wraps an OAuth2 access token as an HTTP bearer credential.
 *
 * @param authCredential The credential holding the access token.
 * @returns A new HTTP bearer credential, or the input credential unchanged
 *   when it carries no access token.
 */
export function generateAuthToken(
  authCredential: AuthCredential,
): AuthCredential {
  const accessToken = authCredential.oauth2?.accessToken;
  if (!accessToken) {
    return authCredential;
  }

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
export class OAuth2CredentialExchanger implements BaseCredentialExchanger {
  @experimental
  async exchange(params: {
    authScheme?: AuthScheme;
    authCredential: AuthCredential;
  }): Promise<ExchangeResult> {
    const {authScheme, authCredential} = params;

    checkSchemeCredentialType(authScheme, authCredential);

    // An HTTP credential is already in the form the header needs.
    if (authCredential.http) {
      return {credential: authCredential, wasExchanged: false};
    }

    if (!authCredential.oauth2?.accessToken) {
      return {credential: authCredential, wasExchanged: false};
    }

    // The refresher checks expiry itself, but it warns when no refresh token is
    // present, so only call it when a refresh can actually happen.
    const credential = authCredential.oauth2.refreshToken
      ? await new OAuth2CredentialRefresher().refresh(
          authCredential,
          authScheme,
        )
      : authCredential;

    return {credential: generateAuthToken(credential), wasExchanged: true};
  }
}
