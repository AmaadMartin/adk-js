/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {base64Encode} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {AuthCredential} from './auth_credential.js';
import {AuthScheme} from './auth_schemes.js';

/** The `in` location an API key scheme must declare to be usable as a header. */
const API_KEY_IN_HEADER = 'header';

/**
 * Builds the HTTP headers that carry a resolved credential.
 *
 * Ported from `google/adk-python` `auth/_auth_headers.py::build_auth_headers`.
 *
 * @param credential The resolved credential.
 * @param authScheme The scheme the credential was resolved for. Only read to
 *   name the header for an API key credential.
 * @return The headers to add to the outgoing request, or `undefined` when the
 *   credential cannot be expressed as headers. A failed exchange leaves the
 *   credential without a token, and that case returns `undefined` rather than
 *   an `Authorization: Bearer undefined` header.
 */
export function buildAuthHeaders(
  credential?: AuthCredential,
  authScheme?: AuthScheme,
): Record<string, string> | undefined {
  if (!credential) {
    return undefined;
  }
  if (credential.oauth2) {
    const token = credential.oauth2.accessToken;
    return token ? {Authorization: `Bearer ${token}`} : undefined;
  }
  if (credential.http) {
    return httpHeaders(credential.http);
  }
  if (credential.apiKey) {
    return apiKeyHeaders(credential.apiKey, authScheme);
  }
  return undefined;
}

/** Builds the headers for an HTTP-scheme credential. */
function httpHeaders(
  http: NonNullable<AuthCredential['http']>,
): Record<string, string> | undefined {
  const scheme = http.scheme.toLowerCase();
  const {token, username, password} = http.credentials;
  let headers: Record<string, string> | undefined;

  if (scheme === 'basic') {
    if (username && password) {
      headers = {
        Authorization: `Basic ${base64Encode(`${username}:${password}`)}`,
      };
    }
  } else if (token) {
    // `bearer` keeps its canonical casing; any other registered scheme is sent
    // with the spelling the caller configured.
    const prefix = scheme === 'bearer' ? 'Bearer' : http.scheme;
    headers = {Authorization: `${prefix} ${token}`};
  }

  if (http.additionalHeaders) {
    headers = {...headers, ...http.additionalHeaders};
  }
  return headers;
}

/** Builds the headers for an API key credential, which the scheme names. */
function apiKeyHeaders(
  apiKey: string,
  authScheme?: AuthScheme,
): Record<string, string> | undefined {
  if (!authScheme) {
    return undefined;
  }
  if ('in' in authScheme && authScheme.in !== API_KEY_IN_HEADER) {
    logger.warn(
      'Only header-based API key authentication is supported. Configured' +
        ` location: ${authScheme.in}`,
    );
    return undefined;
  }
  if (!('name' in authScheme) || !authScheme.name) {
    logger.warn(
      `Cannot send an API key with a '${authScheme.type}' scheme: it does not` +
        ' name a header.',
    );
    return undefined;
  }
  return {[authScheme.name]: apiKey};
}
