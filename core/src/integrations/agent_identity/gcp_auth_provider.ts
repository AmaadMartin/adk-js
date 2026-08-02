/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {BaseAuthProvider} from '../../auth/base_auth_provider.js';
import {AgentIdentityCredentialsProvider} from './agent_identity_credentials_provider.js';
import {
  GcpAuthProviderScheme,
  isGcpAuthProviderScheme,
} from './gcp_auth_provider_scheme.js';
import {IamConnectorCredentialsProvider} from './iam_connector_credentials_provider.js';

/** Resource names served by the IAM Connector Credentials backend. */
const CONNECTOR_RESOURCE_NAME =
  /^projects\/[^/]+\/locations\/[^/]+\/connectors\/[^/]+$/;

/**
 * Auth configuration carrying a {@link GcpAuthProviderScheme}.
 *
 * `AuthConfig.authScheme` is the OpenAPI-derived `AuthScheme` union, which
 * cannot hold a custom scheme, so {@link GcpAuthProvider} accepts this shape
 * as well.
 */
export interface GcpAuthConfig {
  authScheme: GcpAuthProviderScheme;
}

/**
 * An auth provider that obtains end-user access tokens from a Google Cloud
 * credentials service.
 *
 * The scheme's resource name selects the backend: `.../connectors/*` is served
 * by the IAM Connector Credentials service, anything else by the Agent
 * Identity Credentials service.
 */
export class GcpAuthProvider implements BaseAuthProvider {
  private readonly agentIdentityProvider =
    new AgentIdentityCredentialsProvider();
  private readonly iamConnectorProvider = new IamConnectorCredentialsProvider();

  /**
   * Retrieves an end-user credential for the configured auth provider.
   *
   * @param authConfig Configuration whose scheme must be a
   *     `GcpAuthProviderScheme`.
   * @param context The current callback context, which must identify the end
   *     user.
   * @throws If the scheme is not a `GcpAuthProviderScheme`.
   */
  async getAuthCredential(
    authConfig: AuthConfig | GcpAuthConfig,
    context?: unknown,
  ): Promise<AuthCredential | undefined> {
    const authScheme: unknown = authConfig.authScheme;
    if (!isGcpAuthProviderScheme(authScheme)) {
      throw new Error(
        `Expected GcpAuthProviderScheme, got ${describeScheme(authScheme)}`,
      );
    }

    if (CONNECTOR_RESOURCE_NAME.test(authScheme.name)) {
      return this.iamConnectorProvider.getAuthCredential(authScheme, context);
    }
    return this.agentIdentityProvider.getAuthCredential(authScheme, context);
  }
}

/**
 * Describes a rejected scheme without disclosing its configuration, which may
 * carry sensitive values.
 */
export function describeScheme(scheme: unknown): string {
  if (typeof scheme === 'object' && scheme !== null && 'type' in scheme) {
    const type = scheme.type;
    if (typeof type === 'string') {
      return type;
    }
  }
  return typeof scheme;
}
