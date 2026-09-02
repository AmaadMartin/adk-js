/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';

type Oauth2Flow = OpenAPIV3.OAuth2SecurityScheme['flows'];

/**
 * OpenIdConnectWithConfig extends OpenIdSecurityScheme with additional
 * configuration options.
 */
export interface OpenIdConnectWithConfig
  extends OpenAPIV3.OpenIdSecurityScheme {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint?: string;
  revocationEndpoint?: string;
  tokenEndpointAuthMethodsSupported?: string[];
  grantTypesSupported?: string[];
  scopes?: string[];
}

/**
 * A flexible base for custom authentication schemes.
 *
 * Extend it to declare a scheme outside the OpenAPI 3.0 set. The extending
 * interface fixes `type` to its own literal, which is what lets a consumer tell
 * one custom scheme from another. That literal is also the key the scheme's
 * provider is registered under in `AuthProviderRegistry`.
 */
export interface CustomAuthScheme {
  type: string;
}

/**
 * Security scheme types defined by OpenAPI 3.0.
 *
 * The values are the OpenAPI wire names, so they compare directly against the
 * `type` of an {@link AuthScheme}.
 */
export enum AuthSchemeType {
  API_KEY = 'apiKey',
  HTTP = 'http',
  OAUTH2 = 'oauth2',
  OPEN_ID_CONNECT = 'openIdConnect',
}

/**
 * AuthSchemes contains SecuritySchemes from OpenAPI 3.0, an extra flattened
 * OpenIdConnectWithConfig, and external schemes that extend CustomAuthScheme.
 */
export type AuthScheme =
  | OpenAPIV3.SecuritySchemeObject
  | OpenIdConnectWithConfig
  | CustomAuthScheme;

/**
 * Represents the OAuth2 flow (or grant type).
 */
export enum OAuthGrantType {
  CLIENT_CREDENTIALS = 'client_credentials',
  AUTHORIZATION_CODE = 'authorization_code',
  IMPLICIT = 'implicit',
  PASSWORD = 'password',
}

/**
 * Converts an OAuthFlows object to a OAuthGrantType.
 */
export function getOAuthGrantTypeFromFlow(
  flow: Oauth2Flow,
): OAuthGrantType | undefined {
  if (flow.clientCredentials) {
    return OAuthGrantType.CLIENT_CREDENTIALS;
  }

  if (flow.authorizationCode) {
    return OAuthGrantType.AUTHORIZATION_CODE;
  }

  if (flow.implicit) {
    return OAuthGrantType.IMPLICIT;
  }

  if (flow.password) {
    return OAuthGrantType.PASSWORD;
  }

  return undefined;
}
