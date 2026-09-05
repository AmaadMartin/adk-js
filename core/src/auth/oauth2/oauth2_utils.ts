/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../../utils/logger.js';
import {redactUriPassword} from '../../utils/redact_uri.js';
import {OAuth2Auth} from '../auth_credential.js';

import {
  AuthScheme,
  isExtendedOAuth2,
  isOAuth2Scheme,
  OpenIdConnectWithConfig,
} from '../auth_schemes.js';
import {
  OAuth2DiscoveryManager,
  validateDiscoveryUrl,
} from './oauth2_discovery.js';

/**
 * Returns the token endpoint for the given auth scheme.
 */
export function getTokenEndpoint(authScheme: AuthScheme): string | undefined {
  if (
    authScheme.type === 'openIdConnect' &&
    (authScheme as OpenIdConnectWithConfig).tokenEndpoint
  ) {
    return (authScheme as OpenIdConnectWithConfig).tokenEndpoint;
  }

  if (isOAuth2Scheme(authScheme)) {
    const flows = authScheme.flows;
    const flow =
      flows.authorizationCode ||
      flows.clientCredentials ||
      flows.password ||
      flows.implicit;

    if (flow && 'tokenUrl' in flow) {
      return flow.tokenUrl;
    }
  }

  return undefined;
}

interface OAuth2TokenResponse {
  access_token?: string;
  expires_in?: number;
  id_token?: string;
  refresh_token?: string;
}

/**
 * Fetches OAuth2 tokens from the endpoint using the given body.
 */
export async function fetchOAuth2Tokens(
  endpoint: string,
  body: URLSearchParams,
): Promise<OAuth2Auth> {
  // Guard against SSRF: apply the same blocklist used in oauth2_discovery.ts
  // so callers can't point tokenUrl at a private/cloud-metadata address.
  if (!validateDiscoveryUrl(endpoint)) {
    throw new Error(
      `SSRF protection: OAuth2 token endpoint '${endpoint}' is not allowed. Must use HTTPS and must not target private/loopback/cloud-metadata addresses.`,
    );
  }
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      // Never follow redirects: the SSRF blocklist only validates `endpoint`,
      // so a validated host that responds with a 3xx could otherwise redirect
      // this credential-bearing POST (client_secret/refresh_token) to a
      // private/cloud-metadata address (CWE-918).
      redirect: 'error',
    });

    if (!response.ok) {
      throw new Error(`Token request failed with status ${response.status}`);
    }

    const data = (await response.json()) as OAuth2TokenResponse;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
      expiresIn: data.expires_in,
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : undefined,
    };
  } catch (e) {
    logger.error(`Failed to fetch OAuth2 tokens: ${e}`);
    throw e;
  }
}

/**
 * Parses the authorization code from an authorization response URI.
 */
export function parseAuthorizationCode(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    return url.searchParams.get('code') || undefined;
  } catch {
    logger.warn(`Failed to parse authorization URI ${redactUriPassword(uri)}`);
    return undefined;
  }
}

/**
 * Parameters for a Client Credentials token request.
 */
export interface ClientCredentialsParams {
  grantType: 'client_credentials';
  clientId: string;
  clientSecret: string;
}

/**
 * Parameters for an Authorization Code token request.
 */
export interface AuthorizationCodeParams {
  grantType: 'authorization_code';
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri?: string;
  codeVerifier?: string;
}

/**
 * Parameters for a Refresh Token request.
 */
export interface RefreshTokenParams {
  grantType: 'refresh_token';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * Parameters for creating an OAuth2 token request body.
 */
export type OAuth2TokenRequestParams =
  | ClientCredentialsParams
  | AuthorizationCodeParams
  | RefreshTokenParams;

/**
 * Creates URLSearchParams for an OAuth2 token request.
 */
export function createOAuth2TokenRequestBody(
  params: OAuth2TokenRequestParams,
): URLSearchParams {
  const body = new URLSearchParams();
  body.set('grant_type', params.grantType);
  body.set('client_id', params.clientId);
  body.set('client_secret', params.clientSecret);

  if (params.grantType === 'authorization_code') {
    body.set('code', params.code);
    if (params.redirectUri) {
      body.set('redirect_uri', params.redirectUri);
    }
    if (params.codeVerifier) {
      body.set('code_verifier', params.codeVerifier);
    }
  } else if (params.grantType === 'refresh_token') {
    body.set('refresh_token', params.refreshToken);
  }

  return body;
}

export function isTokenExpired(token: OAuth2Auth, leeway = 60): boolean {
  if (typeof token.expiresAt !== 'number') {
    return false;
  }

  const expirationThreshold = token.expiresAt - leeway * 1000;

  return expirationThreshold < Date.now();
}

/**
 * Fills the empty endpoints of an OAuth2 scheme from the metadata its issuer
 * publishes, and leaves the endpoints that are already set alone.
 *
 * The scheme is modified in place, so a caller that already holds it sees the
 * discovered endpoints. This never throws: a scheme with no issuer, and a
 * discovery call that returns nothing, both resolve to false.
 *
 * @param authScheme The auth scheme to populate.
 * @param discoveryManager The manager that fetches the server metadata. It
 *     enforces the HTTPS-only and private-address rules, so discovery must go
 *     through it rather than through a direct fetch.
 * @returns True when discovery filled the scheme, false otherwise.
 */
export async function populateAuthSchemeFromDiscovery(
  authScheme: AuthScheme,
  discoveryManager: OAuth2DiscoveryManager,
): Promise<boolean> {
  if (!isExtendedOAuth2(authScheme)) {
    logger.warn('No issuerUrl was provided for auto-discovery.');
    return false;
  }

  const metadata = await discoveryManager.discoverAuthServerMetadata(
    authScheme.issuerUrl,
  );
  if (!metadata) {
    logger.warn('Auto-discovery has failed to populate OAuth scheme info.');
    return false;
  }

  const {implicit, password, clientCredentials, authorizationCode} =
    authScheme.flows;
  // An empty string is the "not configured" sentinel here, so `||=` is right
  // and `??=` would leave the empty endpoint in place.
  if (implicit) {
    implicit.authorizationUrl ||= metadata.authorization_endpoint;
  }
  if (password) {
    password.tokenUrl ||= metadata.token_endpoint;
  }
  if (clientCredentials) {
    clientCredentials.tokenUrl ||= metadata.token_endpoint;
  }
  if (authorizationCode) {
    authorizationCode.authorizationUrl ||= metadata.authorization_endpoint;
    authorizationCode.tokenUrl ||= metadata.token_endpoint;
  }
  return true;
}
