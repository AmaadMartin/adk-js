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
 * The security scheme types defined by OpenAPI 3.0. The values are the wire
 * names that appear in a scheme's `type` field.
 */
export enum AuthSchemeType {
  API_KEY = 'apiKey',
  HTTP = 'http',
  OAUTH2 = 'oauth2',
  OPEN_ID_CONNECT = 'openIdConnect',
}

const OPEN_API_SCHEME_TYPES: ReadonlySet<string> = new Set<string>(
  Object.values(AuthSchemeType),
);

/**
 * A flexible base for an authentication scheme outside the OpenAPI 3.0 set.
 *
 * An extending interface fixes `type` to its own literal, and that literal is
 * the key its provider is registered under with
 * `CredentialManager.registerAuthProvider`.
 */
export interface CustomAuthScheme {
  type: string;
}

/**
 * An OAuth2 scheme that names the issuer its endpoints can be discovered from.
 */
export interface ExtendedOAuth2 extends OpenAPIV3.OAuth2SecurityScheme {
  issuerUrl?: string;
}

/**
 * AuthSchemes contains SecuritySchemes from OpenAPI 3.0, an extra flattened
 * OpenIdConnectWithConfig, an OAuth2 scheme that supports endpoint discovery,
 * and schemes outside the OpenAPI 3.0 set.
 */
export type AuthScheme =
  | OpenAPIV3.SecuritySchemeObject
  | OpenIdConnectWithConfig
  | ExtendedOAuth2
  | CustomAuthScheme;

/**
 * Reports whether a scheme is outside the OpenAPI 3.0 set, and so resolves its
 * credential through a registered auth provider.
 */
export function isCustomAuthScheme(
  scheme: AuthScheme,
): scheme is CustomAuthScheme {
  return !OPEN_API_SCHEME_TYPES.has(scheme.type);
}

/** Reports whether a scheme is an OAuth2 scheme that declares its flows. */
export function isOAuth2Scheme(
  scheme: AuthScheme,
): scheme is OpenAPIV3.OAuth2SecurityScheme {
  return (
    scheme.type === AuthSchemeType.OAUTH2 && 'flows' in scheme && !!scheme.flows
  );
}

/** Reports whether an OAuth2 scheme names an issuer to discover endpoints from. */
export function isExtendedOAuth2(
  scheme: AuthScheme,
): scheme is ExtendedOAuth2 & {issuerUrl: string} {
  return (
    isOAuth2Scheme(scheme) &&
    'issuerUrl' in scheme &&
    typeof scheme.issuerUrl === 'string' &&
    scheme.issuerUrl.length > 0
  );
}

/**
 * Reports whether a scheme is an OpenID Connect scheme carrying the flattened
 * discovery configuration.
 */
export function isOpenIdConnectWithConfig(
  scheme: AuthScheme,
): scheme is OpenIdConnectWithConfig {
  return (
    scheme.type === AuthSchemeType.OPEN_ID_CONNECT &&
    'authorizationEndpoint' in scheme &&
    'tokenEndpoint' in scheme
  );
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
