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
 * Base type for an authentication scheme that is not one of the OpenAPI 3.0
 * security-scheme types.
 *
 * Declare an interface extending this one to describe a scheme of your own, and
 * pair it with a provider in {@link AuthProviderRegistry}. The `type` is the
 * registry key, so it must be unique and must not collide with the OpenAPI
 * types (`apiKey`, `http`, `oauth2`, `openIdConnect`).
 *
 * Assign a custom scheme through a typed variable rather than an inline object
 * literal. A fresh literal is excess-property-checked against this interface,
 * which declares only `type`, so extra fields are rejected:
 *
 * ```ts
 * interface AcmeScheme extends CustomAuthScheme {
 *   type: 'acme';
 *   vaultPath: string;
 * }
 * const scheme: AcmeScheme = {type: 'acme', vaultPath: 'p'};
 * const authScheme: AuthScheme = scheme; // ok
 * ```
 */
export interface CustomAuthScheme {
  type: string;
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
 * Returns true if the scheme is an OpenID Connect security scheme.
 *
 * The configuration fields stay optional in the narrowed type because the
 * `type` discriminant does not prove that any of them are present.
 */
export function isOpenIdConnectScheme(
  scheme: AuthScheme,
): scheme is OpenAPIV3.OpenIdSecurityScheme & Partial<OpenIdConnectWithConfig> {
  return scheme.type === 'openIdConnect';
}

/**
 * Returns true if the scheme is an OpenAPI OAuth2 security scheme.
 *
 * The `flows` check is load-bearing: {@link CustomAuthScheme} declares `type`
 * as an open `string`, so a `type === 'oauth2'` comparison alone no longer
 * excludes a custom scheme from the narrowed type.
 */
export function isOAuth2Scheme(
  scheme: AuthScheme,
): scheme is OpenAPIV3.OAuth2SecurityScheme {
  return scheme.type === 'oauth2' && 'flows' in scheme;
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
