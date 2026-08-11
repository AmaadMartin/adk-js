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
 * AuthSchemes contains SecuritySchemes from OpenAPI 3.0 and an extra flattened
 * OpenIdConnectWithConfig.
 */
export type AuthScheme =
  | OpenAPIV3.SecuritySchemeObject
  | OpenIdConnectWithConfig;

/**
 * Base type for auth schemes that are not part of the OpenAPI 3.0 security
 * scheme set, identified by a custom `type` discriminator.
 *
 * This is deliberately not a member of {@link AuthScheme}: a member whose
 * `type` is an open `string` would defeat discriminant narrowing for every
 * existing consumer of that union.
 */
export interface CustomAuthScheme {
  type: string;
}

/** The `type` discriminators of the OpenAPI 3.0 security schemes. */
const OPENAPI_SECURITY_SCHEME_TYPES: ReadonlySet<string> = new Set<
  OpenAPIV3.SecuritySchemeObject['type']
>(['apiKey', 'http', 'oauth2', 'openIdConnect']);

/**
 * Returns whether `scheme` is a {@link CustomAuthScheme} rather than one of the
 * OpenAPI 3.0 security schemes that make up {@link AuthScheme}.
 */
export function isCustomAuthScheme(
  scheme: AuthScheme | CustomAuthScheme,
): scheme is CustomAuthScheme {
  return !OPENAPI_SECURITY_SCHEME_TYPES.has(scheme.type);
}

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
