/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {base64Encode} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {AuthCredential} from './auth_credential.js';
import {AuthScheme} from './auth_schemes.js';

/**
 * Builds the HTTP headers that carry an exchanged credential.
 *
 * @param credential - The resolved credential.
 * @param authScheme - The scheme the credential was resolved for. Only used to
 *   name the header for API key credentials.
 * @returns The headers to add to the outgoing request, or `undefined` when the
 *   credential cannot be expressed as headers. Callers read `undefined` as
 *   "not resolved".
 */
export function buildAuthHeaders(
  credential?: AuthCredential,
  authScheme?: AuthScheme,
): Record<string, string> | undefined {
  if (!credential) {
    return undefined;
  }
  if (credential.oauth2) {
    // A failed exchange returns the credential with no access token. Without
    // this check the header is the literal string "Bearer undefined".
    return credential.oauth2.accessToken
      ? {Authorization: `Bearer ${credential.oauth2.accessToken}`}
      : undefined;
  }
  if (credential.http) {
    return buildHttpAuthHeaders(credential.http);
  }
  if (credential.apiKey) {
    return buildApiKeyHeaders(credential.apiKey, authScheme);
  }
  return undefined;
}

function buildHttpAuthHeaders(
  http: NonNullable<AuthCredential['http']>,
): Record<string, string> | undefined {
  let headers: Record<string, string> | undefined;
  const scheme = http.scheme.toLowerCase();
  const {token, username, password} = http.credentials;

  if (scheme === 'basic') {
    if (username && password) {
      headers = {
        Authorization: `Basic ${base64Encode(`${username}:${password}`)}`,
      };
    }
  } else if (token) {
    // `bearer` is spelled back in its registered casing; any other scheme is
    // sent exactly as the caller declared it.
    const name = scheme === 'bearer' ? 'Bearer' : http.scheme;
    headers = {Authorization: `${name} ${token}`};
  }

  if (http.additionalHeaders) {
    headers = {...headers, ...http.additionalHeaders};
  }
  return headers;
}

function buildApiKeyHeaders(
  apiKey: string,
  authScheme?: AuthScheme,
): Record<string, string> | undefined {
  if (!authScheme || authScheme.type !== 'apiKey') {
    return undefined;
  }
  if (authScheme.in !== 'header') {
    logger.warn(
      'Only header-based API key authentication is supported. Configured' +
        ` location: ${authScheme.in}`,
    );
    return undefined;
  }
  return {[authScheme.name]: apiKey};
}
