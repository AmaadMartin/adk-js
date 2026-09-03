/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {
  AuthCredential,
  AuthCredentialTypes,
  ServiceAccount,
} from '../../../auth/auth_credential.js';

/**
 * Applies the given credential to the request headers and URL.
 *
 * @param url The target URL.
 * @param headers The request headers.
 * @param credential The auth credential.
 * @param authScheme The auth scheme from OpenAPI spec.
 * @returns The updated URL (if modified by query params).
 */
export function applyCredential(
  url: string,
  headers: Record<string, string>,
  credential?: AuthCredential,
  authScheme?: OpenAPIV3.SecuritySchemeObject,
): string {
  if (!credential) return url;

  if (credential.apiKey) {
    let inLocation: string | undefined;
    let name = 'key';

    if (authScheme && authScheme.type === 'apiKey') {
      const apiKeyScheme = authScheme as OpenAPIV3.ApiKeySecurityScheme;
      inLocation = apiKeyScheme.in;
      name = apiKeyScheme.name;
    }

    if (inLocation === 'header') {
      headers[name] = credential.apiKey;
    } else if (inLocation === 'query') {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}${name}=${encodeURIComponent(credential.apiKey)}`;
    } else {
      // Default to header Authorization if not specified or unknown location
      headers['Authorization'] = credential.apiKey;
    }
  } else if (
    credential.http &&
    credential.http.credentials &&
    credential.http.credentials.token
  ) {
    headers['Authorization'] = `Bearer ${credential.http.credentials.token}`;
  }

  return url;
}

/**
 * Helper to create a simple API Key auth scheme.
 */
export function createApiKeyScheme(
  name: string,
  inLocation: 'header' | 'query' | 'cookie',
): OpenAPIV3.SecuritySchemeObject {
  return {
    type: 'apiKey',
    name,
    in: inLocation,
  };
}

/**
 * Helper to create a simple Bearer Token auth scheme.
 */
export function createBearerScheme(): OpenAPIV3.SecuritySchemeObject {
  return {
    type: 'http',
    scheme: 'bearer',
  };
}

/** A service account scheme paired with the credential that satisfies it. */
export interface ServiceAccountSchemeCredential {
  authScheme: OpenAPIV3.OAuth2SecurityScheme;
  authCredential: AuthCredential;
}

/**
 * Placeholder token URL for the service account client-credentials scheme.
 *
 * The service account exchange obtains its own token from Application Default
 * Credentials or a JWT assertion, so it never calls this endpoint. The OAuth2
 * client-credentials model requires a token URL, and the mTLS host form is the
 * one Google API endpoints expect.
 */
const SERVICE_ACCOUNT_TOKEN_URL = 'https://oauth2.mtls.googleapis.com/token';

/**
 * Builds the auth scheme and auth credential for a Google service account.
 *
 * The scheme is an OAuth2 client-credentials flow, matching adk-python's
 * `_service_account_auth_scheme`. That shape marks the credential
 * non-interactive: a credential manager that keys off the flow only
 * auto-exchanges a raw service account when the scheme is OAuth2 or OIDC
 * client-credentials. An HTTP bearer scheme reads as interactive, so the tool
 * asks the client to authorize instead of exchanging the service account it
 * already holds. After exchange the credential is an HTTP bearer token.
 *
 * @param config The service account configuration to exchange at call time.
 * @returns The auth scheme and the auth credential to configure a tool with.
 */
export function serviceAccountSchemeCredential(
  config: ServiceAccount,
): ServiceAccountSchemeCredential {
  return {
    authScheme: {
      type: 'oauth2',
      flows: {
        clientCredentials: {tokenUrl: SERVICE_ACCOUNT_TOKEN_URL, scopes: {}},
      },
    },
    authCredential: {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount: config,
    },
  };
}
