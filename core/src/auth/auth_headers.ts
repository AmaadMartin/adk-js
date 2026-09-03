/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {base64Encode} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {AuthCredential} from './auth_credential.js';
import {AuthScheme} from './auth_schemes.js';

/** Whether the scheme carries an API key, and so names the header to use. */
function isApiKeyScheme(
  scheme: AuthScheme,
): scheme is OpenAPIV3.ApiKeySecurityScheme {
  return scheme.type === 'apiKey';
}

/** Builds the headers an API key credential travels in, if any. */
function apiKeyHeaders(
  apiKey: string,
  scheme?: AuthScheme,
): Record<string, string> | undefined {
  if (!scheme || !isApiKeyScheme(scheme)) {
    logger.warn(
      'An API key credential needs an apiKey auth scheme to name its header.',
    );
    return undefined;
  }
  if (scheme.in !== 'header') {
    logger.warn(
      'Only header-based API key authentication is supported. Configured' +
        ` location: ${scheme.in}`,
    );
    return undefined;
  }
  return {[scheme.name]: apiKey};
}

/** Builds the headers an HTTP credential travels in, if any. */
function httpAuthHeaders(
  http: NonNullable<AuthCredential['http']>,
): Record<string, string> | undefined {
  const {scheme, credentials, additionalHeaders} = http;
  const lowerScheme = scheme.toLowerCase();
  let headers: Record<string, string> | undefined;

  if (lowerScheme === 'bearer' && credentials?.token) {
    headers = {Authorization: `Bearer ${credentials.token}`};
  } else if (lowerScheme === 'basic') {
    if (credentials?.username && credentials.password) {
      const encoded = base64Encode(
        `${credentials.username}:${credentials.password}`,
      );
      headers = {Authorization: `Basic ${encoded}`};
    }
  } else if (credentials?.token) {
    headers = {Authorization: `${scheme} ${credentials.token}`};
  }

  if (additionalHeaders) {
    headers = {...headers, ...additionalHeaders};
  }
  return headers;
}

/**
 * Builds the HTTP headers that carry an exchanged credential.
 *
 * @param credential The resolved credential. May be `undefined`.
 * @param authScheme The scheme the credential was resolved for. Only used to
 *   name the header for API key credentials.
 * @returns The headers to add to the outgoing request, or `undefined` when the
 *   credential cannot be expressed as headers.
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
    return httpAuthHeaders(credential.http);
  }
  if (credential.apiKey) {
    return apiKeyHeaders(credential.apiKey, authScheme);
  }
  return undefined;
}
