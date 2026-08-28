/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts a resolved credential into MCP transport headers.
 *
 * This lives beside the MCP tools rather than in the shared auth layer because
 * the header-only restriction on an API key is MCP's: the protocol has no
 * query string and no cookie jar to put one in.
 */

import {
  AuthCredential,
  HttpAuth,
  OAuth2Auth,
} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {logger} from '../../utils/logger.js';

/** The header every scheme here authenticates with, bar a named API key. */
const AUTHORIZATION_HEADER = 'Authorization';

/** Builds the bearer header for an OAuth2 credential that carries a token. */
function oauth2Headers(oauth2: OAuth2Auth): Record<string, string> | undefined {
  return oauth2.accessToken
    ? {[AUTHORIZATION_HEADER]: `Bearer ${oauth2.accessToken}`}
    : undefined;
}

/** Builds the authorization header an HTTP scheme asks for, when it can. */
function httpAuthorizationHeaders(
  http: HttpAuth,
): Record<string, string> | undefined {
  const {username, password, token} = http.credentials;
  const scheme = http.scheme.toLowerCase();

  if (scheme === 'bearer') {
    return token ? {[AUTHORIZATION_HEADER]: `Bearer ${token}`} : undefined;
  }
  if (scheme === 'basic') {
    if (!username || !password) {
      return undefined;
    }
    const encoded = Buffer.from(`${username}:${password}`).toString('base64');
    return {[AUTHORIZATION_HEADER]: `Basic ${encoded}`};
  }
  return token
    ? {[AUTHORIZATION_HEADER]: `${http.scheme} ${token}`}
    : undefined;
}

/** Builds the HTTP headers, including any the credential adds verbatim. */
function httpHeaders(http: HttpAuth): Record<string, string> | undefined {
  const authorization = httpAuthorizationHeaders(http);
  return http.additionalHeaders
    ? {...authorization, ...http.additionalHeaders}
    : authorization;
}

/**
 * Builds the named header an API key belongs in.
 *
 * @throws If no scheme names the header, or the scheme puts the key somewhere
 *     MCP cannot carry it. Neither message repeats the key.
 */
function apiKeyHeaders(
  apiKey: string,
  authScheme: AuthScheme | undefined,
): Record<string, string> {
  if (authScheme?.type !== 'apiKey') {
    const message =
      'Cannot find corresponding auth scheme for API key credential.';
    logger.error(message);
    throw new Error(message);
  }
  if (authScheme.in !== 'header') {
    const message =
      'MCPTool only supports header-based API key authentication. ' +
      `Configured location: ${authScheme.in}`;
    logger.error(message);
    throw new Error(message);
  }
  return {[authScheme.name]: apiKey};
}

/**
 * Converts a resolved credential into MCP transport headers.
 *
 * @param credential The credential the auth handler resolved, if any.
 * @param authScheme The scheme the tool was configured with. An API key needs
 *     it, because only the scheme names the header the key goes in.
 * @return The headers, or undefined when the credential contributes none.
 * @throws If an API key cannot be turned into a header.
 */
export function credentialToHeaders(
  credential: AuthCredential | undefined,
  authScheme: AuthScheme | undefined,
): Record<string, string> | undefined {
  if (!credential) {
    return undefined;
  }
  if (credential.oauth2) {
    return oauth2Headers(credential.oauth2);
  }
  if (credential.http) {
    return httpHeaders(credential.http);
  }
  if (credential.apiKey) {
    return apiKeyHeaders(credential.apiKey, authScheme);
  }
  if (credential.serviceAccount) {
    logger.warn(
      'A service account credential must be exchanged for an access token ' +
        'before the MCP session is created. It contributes no headers.',
    );
  }
  return undefined;
}
