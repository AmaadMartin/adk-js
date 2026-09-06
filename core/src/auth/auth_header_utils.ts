/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turns a resolved credential into the request headers that carry it.
 *
 * Kept separate from any one transport: a credential authenticates an HTTP
 * request the same way whether the caller speaks REST or the Model Context
 * Protocol.
 */

import {base64Encode} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

import {AuthCredential} from './auth_credential.js';
import {AuthScheme} from './auth_schemes.js';

/**
 * Derives the request headers a credential must be sent as.
 *
 * @param credential The resolved credential, when there is one.
 * @param authScheme The scheme the credential satisfies.
 * @return The headers, or undefined when the credential implies none.
 * @throws If an API key is configured without a header-based scheme.
 */
export function credentialHeaders(
  credential: AuthCredential | undefined,
  authScheme: AuthScheme | undefined,
): Record<string, string> | undefined {
  if (!credential) {
    return undefined;
  }
  if (credential.oauth2) {
    return {Authorization: `Bearer ${credential.oauth2.accessToken}`};
  }
  if (credential.http) {
    return httpHeaders(credential.http);
  }
  if (credential.apiKey) {
    return apiKeyHeaders(credential.apiKey, authScheme);
  }
  if (credential.serviceAccount) {
    logger.warn(
      'Service account credentials should be exchanged before use as a request header',
    );
  }
  return undefined;
}

/** Derives the headers for an HTTP-scheme credential. */
function httpHeaders(
  http: NonNullable<AuthCredential['http']>,
): Record<string, string> | undefined {
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
        // The configured spelling is kept: an RFC 7235 scheme name is
        // case-insensitive, but servers in the wild compare it literally.
        headers = {Authorization: `${scheme} ${credentials.token}`};
      }
      break;
  }
  if (additionalHeaders) {
    headers = {...headers, ...additionalHeaders};
  }
  return headers;
}

/** Derives the header for an API key credential. */
function apiKeyHeaders(
  apiKey: string,
  authScheme: AuthScheme | undefined,
): Record<string, string> {
  if (!authScheme) {
    // The key itself is never named here: the message reaches logs and the
    // model.
    const message =
      'Cannot find corresponding auth scheme for API key credential.';
    logger.error(message);
    throw new Error(message);
  }
  if (authScheme.type === 'apiKey' && authScheme.in === 'header') {
    return {[authScheme.name]: apiKey};
  }
  const location = authScheme.type === 'apiKey' ? authScheme.in : undefined;
  const message =
    'API key authentication is only supported in a header. ' +
    `Configured location: ${location}`;
  logger.error(message);
  throw new Error(message);
}
