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
 * Converts an OAuth2 or OpenID Connect credential into an HTTP bearer
 * credential that the OpenAPI tool layer can send in the Authorization header.
 * Ported from Python implementation.
 */
@experimental
export class OAuth2BearerCredentialExchanger implements BaseCredentialExchanger {
  /**
   * Converts the credential into an HTTP bearer credential.
   *
   * A credential that already carries an HTTP credential, and one with no
   * access token to wrap, both come back unchanged and not exchanged.
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

    // An HTTP credential is already in the form the header needs.
    if (params.authCredential.http) {
      return {credential: params.authCredential, wasExchanged: false};
    }

    const {oauth2} = params.authCredential;
    if (!oauth2?.accessToken) {
      return {credential: params.authCredential, wasExchanged: false};
    }

    // The refresher checks expiry itself, but it warns when no refresh token is
    // present, so only call it when a refresh can actually happen.
    const refreshed = oauth2.refreshToken
      ? await new OAuth2CredentialRefresher().refresh(
          params.authCredential,
          params.authScheme,
        )
      : undefined;

    return {
      credential: generateAuthToken(
        refreshed?.oauth2?.accessToken ?? oauth2.accessToken,
      ),
      wasExchanged: true,
    };
  }
}
