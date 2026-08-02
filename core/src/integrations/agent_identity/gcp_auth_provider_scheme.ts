/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CustomAuthScheme} from '../../auth/auth_schemes.js';

/** Discriminator value identifying a {@link GcpAuthProviderScheme}. */
export const GCP_AUTH_PROVIDER_SCHEME_TYPE = 'gcpAuthProviderScheme';

/**
 * The Agent Identity authentication scheme for Google Cloud Platform.
 */
export interface GcpAuthProviderScheme extends CustomAuthScheme {
  type: typeof GCP_AUTH_PROVIDER_SCHEME_TYPE;

  /** The GCP Auth Provider (or IAM Connector) resource name to use. */
  name: string;

  /** Optional OAuth2 scopes to request. */
  scopes?: string[];

  /**
   * Optional. A redirect URI distinct from the standard OAuth2 redirect URI:
   * the Google-hosted OAuth2 redirect URI sends the user here to
   * reauthenticate and finalize the managed OAuth flow. The agent includes
   * this URI in every 3-legged OAuth request sent to the upstream credentials
   * service, so it must be hosted somewhere reachable by the user, preferably
   * alongside the agent's web server.
   */
  continueUri?: string;
}

/** Returns whether `scheme` is a {@link GcpAuthProviderScheme}. */
export function isGcpAuthProviderScheme(
  scheme: unknown,
): scheme is GcpAuthProviderScheme {
  return (
    typeof scheme === 'object' &&
    scheme !== null &&
    'type' in scheme &&
    scheme.type === GCP_AUTH_PROVIDER_SCHEME_TYPE &&
    'name' in scheme &&
    typeof scheme.name === 'string'
  );
}
