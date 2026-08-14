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
 * OAuth2 scheme that names its issuer, so that the authorization and token
 * endpoints can be discovered instead of configured by hand.
 * @experimental  (Experimental, subject to change)
 */
export interface ExtendedOAuth2 extends OpenAPIV3.OAuth2SecurityScheme {
  /**
   * Issuer URL of the authorization server. It is used to discover the
   * endpoints that are left blank in `flows`.
   */
  issuerUrl?: string;
}

/**
 * AuthSchemes contains SecuritySchemes from OpenAPI 3.0, an extra flattened
 * OpenIdConnectWithConfig, and an OAuth2 scheme that carries an issuer URL.
 */
export type AuthScheme =
  | OpenAPIV3.SecuritySchemeObject
  | OpenIdConnectWithConfig
  | ExtendedOAuth2;

/**
 * Reports whether the scheme is an OAuth2 scheme with a usable issuer URL, and
 * can therefore have its endpoints discovered.
 *
 * An {@link ExtendedOAuth2} without an `issuerUrl` is structurally identical to
 * a plain OAuth2 scheme, so this predicate rejects it.
 */
export function isExtendedOAuth2(
  authScheme: AuthScheme | undefined,
): authScheme is ExtendedOAuth2 & {issuerUrl: string} {
  return (
    authScheme?.type === 'oauth2' &&
    'issuerUrl' in authScheme &&
    !!authScheme.issuerUrl
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
