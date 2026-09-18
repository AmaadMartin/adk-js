/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  HttpAuth,
  HttpCredentials,
  OAuth2Auth,
} from '../../../../auth/auth_credential.js';
import {AuthScheme} from '../../../../auth/auth_schemes.js';
import {BaseAuthCredentialExchanger} from './base_credential_exchanger.js';

/**
 * OAuth2Auth with optional v0.1.0 `token` dictionary support.
 */
export interface OAuth2AuthWithToken extends OAuth2Auth {
  token?: Record<string, string>;
}

/**
 * AuthCredential with optional v0.1.0 `oauth2.token` dictionary support.
 */
export interface OAuth2AuthCredential extends Omit<AuthCredential, 'oauth2'> {
  oauth2?: OAuth2AuthWithToken;
}

/**
 * Fetches credentials for OAuth2 and OpenID Connect.
 */
export class OAuth2CredentialExchanger extends BaseAuthCredentialExchanger {
  /**
   * Validates the security scheme and authentication credential types.
   */
  _checkSchemeCredentialType(
    authScheme: AuthScheme,
    authCredential?: OAuth2AuthCredential | null,
  ): void {
    if (!authCredential) {
      throw new Error(
        'auth_credential is empty. Please create AuthCredential using' +
          ' OAuth2Auth.',
      );
    }

    const schemeType =
      (authScheme as {type_?: string})?.type_ ?? authScheme?.type;

    if (schemeType !== 'openIdConnect' && schemeType !== 'oauth2') {
      throw new Error(
        'Invalid security scheme, expect AuthSchemeType.openIdConnect or ' +
          `AuthSchemeType.oauth2 auth scheme, but got ${schemeType}`,
      );
    }

    if (!authCredential.oauth2 && !authCredential.http) {
      throw new Error(
        'auth_credential is not configured with oauth2. Please' +
          ' create AuthCredential and set OAuth2Auth.',
      );
    }
  }

  /**
   * Snake_case alias for {@link _checkSchemeCredentialType}.
   */
  _check_scheme_credential_type(
    authScheme: AuthScheme,
    authCredential?: OAuth2AuthCredential | null,
  ): void {
    this._checkSchemeCredentialType(authScheme, authCredential);
  }

  /**
   * Generates an auth token from the authorization response.
   *
   * @param authCredential The auth credential.
   * @returns An AuthCredential object containing the HTTP bearer access token.
   *   If the HTTP bearer token cannot be generated, returns the original credential.
   */
  generateAuthToken(
    authCredential?: OAuth2AuthCredential,
  ): AuthCredential {
    if (!authCredential || !authCredential.oauth2) {
      return authCredential as AuthCredential;
    }

    const tokenDict = authCredential.oauth2.token;
    const accessToken =
      tokenDict && 'access_token' in tokenDict
        ? tokenDict['access_token']
        : authCredential.oauth2.accessToken;

    if (accessToken === undefined) {
      return authCredential;
    }

    const credentials: HttpCredentials = {
      token: accessToken,
    };
    const http: HttpAuth = {
      scheme: 'bearer',
      credentials,
    };
    const updatedCredential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http,
    };
    return updatedCredential;
  }

  /**
   * Snake_case alias for {@link generateAuthToken}.
   */
  generate_auth_token(
    authCredential?: OAuth2AuthCredential,
  ): AuthCredential {
    return this.generateAuthToken(authCredential);
  }

  /**
   * Exchanges the OpenID Connect or OAuth2 auth credential for an access token.
   *
   * @param authScheme The auth scheme.
   * @param authCredential The auth credential.
   * @returns An AuthCredential object containing the HTTP Bearer access token,
   *   or null if no token is present to exchange.
   * @throws Error If the auth scheme or auth credential is invalid.
   */
  override exchangeCredential(
    authScheme: AuthScheme,
    authCredential?: OAuth2AuthCredential,
  ): AuthCredential {
    // TODO(cheliu): Implement token refresh flow

    this._checkSchemeCredentialType(authScheme, authCredential);

    // If token is already HTTPBearer token, do nothing assuming that this token
    // is valid.
    if (authCredential!.http) {
      return authCredential!;
    }

    // If access token is exchanged, exchange a HTTPBearer token.
    const tokenDict = authCredential!.oauth2?.token;
    const hasTokenDict =
      tokenDict !== undefined &&
      tokenDict !== null &&
      Object.keys(tokenDict).length > 0;
    const hasAccessToken = authCredential!.oauth2?.accessToken !== undefined;

    if (hasTokenDict || hasAccessToken) {
      return this.generateAuthToken(authCredential!);
    }

    return null as unknown as AuthCredential;
  }

  /**
   * Snake_case alias for {@link exchangeCredential}.
   */
  override exchange_credential(
    authScheme: AuthScheme,
    authCredential?: OAuth2AuthCredential,
  ): AuthCredential {
    return this.exchangeCredential(authScheme, authCredential);
  }
}
