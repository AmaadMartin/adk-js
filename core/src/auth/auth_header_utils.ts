/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential, AuthCredentialTypes} from './auth_credential.js';
import {AuthScheme} from './auth_schemes.js';

/**
 * Builds the HTTP headers that present a credential on an outgoing request.
 *
 * A credential that still needs an exchange to become a token produces no
 * headers, and so does one the scheme gives nowhere to put. The caller sends
 * the request unauthenticated in that case rather than sending a broken one.
 *
 * @param authScheme The scheme the credential belongs to. An `apiKey` scheme
 *     names the header the key goes in.
 * @param authCredential The credential to present.
 * @return The headers to add, empty when the credential cannot be presented
 *     as it stands.
 */
export function buildAuthHeaders(
  authScheme?: AuthScheme,
  authCredential?: AuthCredential,
): Record<string, string> {
  if (!authCredential) {
    return {};
  }
  switch (authCredential.authType) {
    case AuthCredentialTypes.HTTP:
      return httpAuthHeaders(authCredential);
    case AuthCredentialTypes.API_KEY:
      return apiKeyHeaders(authScheme, authCredential);
    case AuthCredentialTypes.OAUTH2:
    case AuthCredentialTypes.OPEN_ID_CONNECT:
      return bearerHeaders(authCredential.oauth2?.accessToken);
    default:
      return {};
  }
}

/** Builds the `Authorization` header for an HTTP auth credential. */
function httpAuthHeaders(
  authCredential: AuthCredential,
): Record<string, string> {
  const http = authCredential.http;
  if (!http) {
    return {};
  }
  const scheme = http.scheme.toLowerCase();
  if (scheme === 'basic') {
    const {username, password} = http.credentials;
    if (username === undefined || password === undefined) {
      return {};
    }
    const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString(
      'base64',
    );
    return {'Authorization': `Basic ${encoded}`};
  }
  if (!http.credentials.token) {
    return {};
  }
  // RFC 7235 keeps the scheme name as the server declared it.
  return {'Authorization': `${http.scheme} ${http.credentials.token}`};
}

/**
 * Builds the header an API key goes in. Only an `apiKey` scheme that puts the
 * key in a header names one; a query or cookie key is not a header.
 */
function apiKeyHeaders(
  authScheme: AuthScheme | undefined,
  authCredential: AuthCredential,
): Record<string, string> {
  if (
    !authCredential.apiKey ||
    authScheme?.type !== 'apiKey' ||
    authScheme.in !== 'header'
  ) {
    return {};
  }
  return {[authScheme.name]: authCredential.apiKey};
}

/** Builds the `Authorization` header for an already-exchanged access token. */
function bearerHeaders(accessToken?: string): Record<string, string> {
  return accessToken ? {'Authorization': `Bearer ${accessToken}`} : {};
}
