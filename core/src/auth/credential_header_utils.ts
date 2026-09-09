/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {base64Encode} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

import {AuthCredential, HttpAuth} from './auth_credential.js';
import {AuthScheme} from './auth_schemes.js';

/**
 * Resolves the header name an API key credential is sent under.
 *
 * @param authScheme The scheme the credential belongs to.
 * @return The header name declared by the scheme.
 * @throws If the scheme is missing, is not an `apiKey` scheme, or places the
 *   key somewhere other than the request headers.
 */
function apiKeyHeaderName(authScheme?: AuthScheme): string {
  if (!authScheme || authScheme.type !== 'apiKey') {
    throw new Error(
      'API key authentication requires an apiKey auth scheme; none is ' +
        'configured.',
    );
  }
  if (authScheme.in !== 'header') {
    throw new Error(
      'API key authentication requires an apiKey auth scheme located in the ' +
        `header; got: ${authScheme.in}`,
    );
  }
  return authScheme.name;
}

/**
 * Builds the request headers carrying an HTTP credential.
 *
 * `bearer` and `basic` are spelled out because they have a defined encoding;
 * any other scheme is sent verbatim with its token, keeping the casing the
 * caller configured. `additionalHeaders` is merged on top, and applies even
 * when no scheme produced an `Authorization` header.
 *
 * @param http The HTTP credential to render.
 * @return The headers, or `undefined` when the credential carries nothing
 *   sendable.
 */
function httpAuthToHeaders(http: HttpAuth): Record<string, string> | undefined {
  const {scheme, credentials, additionalHeaders} = http;
  let headers: Record<string, string> | undefined;

  switch (scheme.toLowerCase()) {
    case 'bearer':
      if (credentials.token) {
        headers = {Authorization: `Bearer ${credentials.token}`};
      }
      break;
    case 'basic':
      if (credentials.username && credentials.password) {
        const encoded = base64Encode(
          `${credentials.username}:${credentials.password}`,
        );
        headers = {Authorization: `Basic ${encoded}`};
      }
      break;
    default:
      if (credentials.token) {
        headers = {Authorization: `${scheme} ${credentials.token}`};
      }
      break;
  }

  if (additionalHeaders) {
    headers = {...headers, ...additionalHeaders};
  }
  return headers;
}

/**
 * Converts a resolved credential into the HTTP headers that carry it.
 *
 * The credential kinds are mutually exclusive and resolve in this order:
 * OAuth2, HTTP, API key, service account. A service account credential yields
 * no headers: it must be exchanged for an access token before it can be sent.
 *
 * @param credential The credential to render, already exchanged if it needed
 *   exchanging.
 * @param authScheme The scheme the credential belongs to. Only an API key
 *   credential needs it, to learn which header the key goes in.
 * @return The headers to attach to the request, or `undefined` when the
 *   credential carries nothing sendable.
 * @throws If the credential is an API key and `authScheme` is not an `apiKey`
 *   scheme located in the header.
 */
export function authCredentialToHeaders(
  credential?: AuthCredential,
  authScheme?: AuthScheme,
): Record<string, string> | undefined {
  if (!credential) {
    return undefined;
  }
  if (credential.oauth2) {
    return {Authorization: `Bearer ${credential.oauth2.accessToken}`};
  }
  if (credential.http) {
    return httpAuthToHeaders(credential.http);
  }
  if (credential.apiKey) {
    return {[apiKeyHeaderName(authScheme)]: credential.apiKey};
  }
  if (credential.serviceAccount) {
    logger.warn(
      'A service account credential must be exchanged for an access token ' +
        'before it can be sent as a request header.',
    );
  }
  return undefined;
}
