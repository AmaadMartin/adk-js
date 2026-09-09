/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../utils/logger.js';

import {AuthCredential, HttpAuth} from './auth_credential.js';
import {AuthScheme} from './auth_schemes.js';

/** Turns an HTTP credential into its `Authorization` header, if it has one. */
function httpAuthHeaders(http: HttpAuth): Record<string, string> | undefined {
  const scheme = http.scheme.toLowerCase();
  const {token, username, password} = http.credentials;

  if (scheme === 'bearer') {
    return token ? {Authorization: `Bearer ${token}`} : undefined;
  }

  if (scheme === 'basic') {
    if (!username || !password) {
      return undefined;
    }
    const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString(
      'base64',
    );
    return {Authorization: `Basic ${encoded}`};
  }

  // Any other registered scheme keeps the spelling it was configured with.
  return token ? {Authorization: `${http.scheme} ${token}`} : undefined;
}

/** Names the header an API key travels in, per the scheme that declared it. */
function apiKeyHeaders(
  apiKey: string,
  authScheme?: AuthScheme,
): Record<string, string> | undefined {
  if (!authScheme || authScheme.type !== 'apiKey') {
    return undefined;
  }
  if (authScheme.in !== 'header') {
    logger.warn(
      'Only header-based API key authentication is supported. Configured ' +
        `location: ${authScheme.in}.`,
    );
    return undefined;
  }
  return {[authScheme.name]: apiKey};
}

/**
 * Builds the HTTP headers that carry an exchanged credential.
 *
 * Mirrors adk-python's `google.adk.auth._auth_headers.build_auth_headers`.
 *
 * @param credential The resolved credential, if there is one.
 * @param authScheme The scheme the credential was resolved for. Only an API key
 *     needs it, to learn which header to travel in.
 * @return The headers to add to the outgoing request, or `undefined` when the
 *     credential cannot be expressed as headers.
 */
export function buildAuthHeaders(
  credential: AuthCredential | undefined,
  authScheme?: AuthScheme,
): Record<string, string> | undefined {
  if (!credential) {
    return undefined;
  }

  if (credential.oauth2) {
    // A failed exchange returns the credential with no access token. Without
    // this check the header is the literal string `Bearer undefined`.
    const accessToken = credential.oauth2.accessToken;
    return accessToken ? {Authorization: `Bearer ${accessToken}`} : undefined;
  }

  if (credential.http) {
    const headers = httpAuthHeaders(credential.http);
    const additional = credential.http.additionalHeaders;
    if (!additional) {
      return headers;
    }
    return {...headers, ...additional};
  }

  if (credential.apiKey) {
    return apiKeyHeaders(credential.apiKey, authScheme);
  }

  if (credential.serviceAccount) {
    logger.warn(
      'A service account credential cannot be sent as a header. Exchange it ' +
        'for an access token first.',
    );
  }

  return undefined;
}
