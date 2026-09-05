/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CustomAuthScheme} from '../../auth/auth_schemes.js';

/**
 * The Agent Identity authentication scheme for Google Cloud Platform.
 *
 * It names an auth provider resource. `GcpAuthProvider` reads the resource name
 * and asks the matching Google Cloud credentials service for the credential.
 */
export interface GcpAuthProviderScheme extends CustomAuthScheme {
  /** The type of the security scheme, always `gcpAuthProviderScheme`. */
  type: 'gcpAuthProviderScheme';

  /** The name of the GCP Auth Provider resource to use. */
  name: string;

  /** Optional. The OAuth2 scopes to request. */
  scopes?: string[];

  /**
   * Optional. A redirect URI, distinct from the standard OAuth2 one.
   *
   * It re-authenticates the user to prevent a phishing attack, and it finalises
   * the managed OAuth flow. The Google-hosted OAuth2 redirect URI sends the
   * user on to this continue URI. The agent includes the URI in every
   * three-legged OAuth request it sends to the upstream Agent Identity
   * Credentials service. You host the URI yourself, preferably alongside the
   * agent client's web server.
   */
  continueUri?: string;
}
