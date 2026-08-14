/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../../utils/logger.js';
import {OAuth2Auth} from '../auth_credential.js';

import {
  AuthScheme,
  ExtendedOAuth2,
  isExtendedOAuth2,
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

  if (authScheme.type === 'oauth2' && authScheme.flows) {
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

/**
 * Whether any configured flow is still missing an authorization or token URL.
 */
function hasMissingEndpoints(flows: ExtendedOAuth2['flows']): boolean {
  const {implicit, password, clientCredentials, authorizationCode} = flows;

  return Boolean(
    (implicit && !implicit.authorizationUrl) ||
    (password && !password.tokenUrl) ||
    (clientCredentials && !clientCredentials.tokenUrl) ||
    (authorizationCode &&
      (!authorizationCode.authorizationUrl || !authorizationCode.tokenUrl)),
  );
}

/**
 * Fills the flow endpoints an `ExtendedOAuth2` scheme left empty from the
 * authorization server metadata published by its issuer (RFC 8414).
 *
 * The scheme is mutated in place, so a tool discovers its endpoints once
 * rather than on every invocation. An endpoint the user configured is never
 * overwritten, and a failed discovery leaves the scheme unchanged instead of
 * throwing.
 *
 * @returns Whether metadata was discovered and applied to the scheme.
 */
export async function populateOAuth2Endpoints(
  authScheme: AuthScheme,
): Promise<boolean> {
  if (
    !isExtendedOAuth2(authScheme) ||
    !authScheme.issuerUrl ||
    // A scheme read from user configuration can reach here without any flows,
    // even though the OpenAPI type declares the field as required.
    !authScheme.flows ||
    !hasMissingEndpoints(authScheme.flows)
  ) {
    return false;
  }

  const metadata =
    await new OAuth2DiscoveryManager().discoverAuthServerMetadata(
      authScheme.issuerUrl,
    );
  if (!metadata) {
    logger.warn(
      `OAuth2 endpoint discovery failed for issuer ${authScheme.issuerUrl}.`,
    );
    return false;
  }

  const {implicit, password, clientCredentials, authorizationCode} =
    authScheme.flows;
  if (implicit && !implicit.authorizationUrl) {
    implicit.authorizationUrl = metadata.authorization_endpoint;
  }
  if (password && !password.tokenUrl) {
    password.tokenUrl = metadata.token_endpoint;
  }
  if (clientCredentials && !clientCredentials.tokenUrl) {
    clientCredentials.tokenUrl = metadata.token_endpoint;
  }
  if (authorizationCode && !authorizationCode.authorizationUrl) {
    authorizationCode.authorizationUrl = metadata.authorization_endpoint;
  }
  if (authorizationCode && !authorizationCode.tokenUrl) {
    authorizationCode.tokenUrl = metadata.token_endpoint;
  }

  return true;
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
  } catch (e) {
    logger.warn(`Failed to parse authorization URI ${uri}: ${e}`);
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
