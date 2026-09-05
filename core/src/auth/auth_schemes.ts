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
 * A Google Cloud auth provider, named by its resource name.
 *
 * A registered Google Cloud resource is bound to an auth provider through an
 * IAM binding, and the provider runs the authorization flow on the caller's
 * behalf. OpenAPI 3.0 has no scheme for this, so it is its own member of
 * {@link AuthScheme}.
 */
export interface GcpAuthProviderScheme {
  type: 'gcpAuthProviderScheme';
  /** Resource name of the auth provider. */
  name: string;
  scopes?: string[];
  /** Redirect target that overrides the one the provider declares. */
  continueUri?: string;
}

/**
 * AuthSchemes contains SecuritySchemes from OpenAPI 3.0, an extra flattened
 * OpenIdConnectWithConfig, and {@link GcpAuthProviderScheme}.
 */
export type AuthScheme =
  | OpenAPIV3.SecuritySchemeObject
  | OpenIdConnectWithConfig
  | GcpAuthProviderScheme;

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
