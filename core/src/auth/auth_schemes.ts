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
 * The security scheme types that OpenAPI 3.0 defines.
 *
 * The member values are the wire names, so they compare directly against the
 * `type` of an {@link AuthScheme}. A scheme whose `type` is outside this set is
 * a {@link CustomAuthScheme}.
 */
export enum AuthSchemeType {
  /** An API key sent in a header, a query parameter or a cookie. */
  API_KEY = 'apiKey',
  /** An HTTP authentication scheme, such as `basic` or `bearer`. */
  HTTP = 'http',
  /** An OAuth2 scheme, described by its flows. */
  OAUTH2 = 'oauth2',
  /** An OpenID Connect scheme, described by its discovery document. */
  OPEN_ID_CONNECT = 'openIdConnect',
}

const OPEN_API_SCHEME_TYPES: ReadonlySet<string> = new Set(
  Object.values(AuthSchemeType),
);

/**
 * A flexible base for an authentication scheme that OpenAPI 3.0 does not
 * define.
 *
 * Extend it to declare an external scheme, and pin `type` to the literal that
 * identifies it:
 *
 * ```ts
 * interface MyProviderScheme extends CustomAuthScheme {
 *   type: 'myProviderScheme';
 *   name: string;
 * }
 * ```
 *
 * The extending interface carries its own fields, so a consumer keeps full type
 * checking. Use {@link isCustomAuthScheme} to tell a custom scheme from an
 * OpenAPI one at runtime.
 */
export interface CustomAuthScheme {
  /** The scheme type, outside the {@link AuthSchemeType} set. */
  type: string;
}

/**
 * An OAuth2 scheme that names the issuer its endpoints come from.
 *
 * Set `issuerUrl` and leave the endpoints of each flow empty. The caller then
 * passes the scheme to `populateAuthSchemeFromDiscovery`, which reads the
 * issuer metadata and fills the endpoints in.
 *
 * @experimental This scheme may change without a major version bump.
 */
export interface ExtendedOAuth2 extends OpenAPIV3.OAuth2SecurityScheme {
  /**
   * The issuer to discover the OAuth2 endpoints from, per RFC 8414.
   */
  issuerUrl?: string;
}

/**
 * AuthSchemes contains SecuritySchemes from OpenAPI 3.0, an extra flattened
 * OpenIdConnectWithConfig, and external schemes that extend CustomAuthScheme.
 */
export type AuthScheme =
  | OpenAPIV3.SecuritySchemeObject
  | OpenIdConnectWithConfig
  | ExtendedOAuth2
  | CustomAuthScheme;

/**
 * Reports whether the scheme is an external one that OpenAPI 3.0 does not
 * define.
 */
export function isCustomAuthScheme(
  scheme: AuthScheme,
): scheme is CustomAuthScheme {
  return !OPEN_API_SCHEME_TYPES.has(scheme.type);
}

/**
 * Reports whether the scheme is an OAuth2 scheme that declares its flows.
 */
export function isOAuth2Scheme(
  scheme: AuthScheme,
): scheme is OpenAPIV3.OAuth2SecurityScheme {
  return (
    scheme.type === AuthSchemeType.OAUTH2 && 'flows' in scheme && !!scheme.flows
  );
}

/**
 * Reports whether the scheme is an {@link ExtendedOAuth2} that carries an
 * issuer, which is what makes endpoint discovery possible.
 */
export function isExtendedOAuth2(
  scheme: AuthScheme,
): scheme is ExtendedOAuth2 & {issuerUrl: string} {
  return (
    isOAuth2Scheme(scheme) &&
    'issuerUrl' in scheme &&
    typeof scheme.issuerUrl === 'string' &&
    scheme.issuerUrl !== ''
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
