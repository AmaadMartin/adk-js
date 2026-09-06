/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../utils/logger.js';

import {AuthCredential, HttpAuth} from './auth_credential.js';
import {AuthScheme} from './auth_schemes.js';

const AUTHORIZATION_HEADER = 'Authorization';

/**
 * Turns an exchanged credential into the HTTP headers that carry it.
 *
 * The scheme is only consulted for an API key, whose header name the
 * credential itself does not carry.
 *
 * @param credential The exchanged credential. Omit it for an unauthenticated
 *     request.
 * @param authScheme The scheme the credential was exchanged for.
 * @return The headers to send, or `undefined` when the credential carries
 *     nothing sendable.
 */
export function buildAuthHeaders(
  credential?: AuthCredential,
  authScheme?: AuthScheme,
): Record<string, string> | undefined {
  if (!credential) {
    return undefined;
  }

  if (credential.oauth2) {
    const accessToken = credential.oauth2.accessToken;
    return accessToken
      ? {[AUTHORIZATION_HEADER]: `Bearer ${accessToken}`}
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

/**
 * Builds the headers for an HTTP-scheme credential (RFC 7235), including any
 * additional headers the credential carries.
 */
function buildHttpAuthHeaders(
  http: HttpAuth,
): Record<string, string> | undefined {
  // A credential read from a document can omit `credentials` even though the
  // type makes it mandatory.
  const {token, username, password} = http.credentials ?? {};
  const scheme = http.scheme.toLowerCase();

  let headers: Record<string, string> | undefined;
  if (scheme === 'bearer' && token) {
    headers = {[AUTHORIZATION_HEADER]: `Bearer ${token}`};
  } else if (scheme === 'basic') {
    if (username && password) {
      const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString(
        'base64',
      );
      headers = {[AUTHORIZATION_HEADER]: `Basic ${encoded}`};
    }
  } else if (token) {
    headers = {[AUTHORIZATION_HEADER]: `${http.scheme} ${token}`};
  }

  if (http.additionalHeaders) {
    headers = {...headers, ...http.additionalHeaders};
  }
  return headers;
}

/** Builds the header an API key is sent in, as named by its scheme. */
function buildApiKeyHeaders(
  apiKey: string,
  authScheme?: AuthScheme,
): Record<string, string> | undefined {
  if (authScheme?.type !== 'apiKey') {
    logger.warn(
      'An API key credential needs an apiKey auth scheme to name the header ' +
        'it is sent in. No auth header was built.',
    );
    return undefined;
  }

  // A scheme parsed from a document can omit `in` even though the type makes
  // it mandatory. The key then goes in the header the scheme names.
  if (authScheme.in && authScheme.in !== 'header') {
    logger.warn(
      'Only header-based API key authentication is supported. Configured ' +
        `location: ${authScheme.in}.`,
    );
    return undefined;
  }

  return {[authScheme.name]: apiKey};
}
