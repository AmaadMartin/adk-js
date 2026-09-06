/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {BaseAuthProvider} from '../../auth/base_auth_provider.js';
import {experimental} from '../../utils/experimental.js';
import {AgentIdentityCredentialsProvider} from './agent_identity_credentials_provider.js';
import {GcpAuthProviderScheme} from './gcp_auth_provider_scheme.js';

/** The scheme `type` this provider is registered under. */
export const GCP_AUTH_PROVIDER_SCHEME_TYPE = 'gcpAuthProviderScheme';

/** Legacy resource names that name an IAM connector rather than a provider. */
const CONNECTOR_RESOURCE_NAME_PATTERN =
  /^projects\/[^/]+\/locations\/[^/]+\/connectors\/[^/]+$/;

/** True when `scheme` is a {@link GcpAuthProviderScheme}. */
export function isGcpAuthProviderScheme(
  scheme: AuthScheme,
): scheme is GcpAuthProviderScheme {
  return scheme.type === GCP_AUTH_PROVIDER_SCHEME_TYPE && 'name' in scheme;
}

/**
 * Serves a `gcpAuthProviderScheme` from a Google Cloud credentials service.
 *
 * Register it once, then any toolset configured with a `gcpAuthProviderScheme`
 * gets its end-user credential without the agent author writing OAuth code.
 */
@experimental
export class GcpAuthProvider implements BaseAuthProvider {
  readonly supportedAuthSchemes: readonly string[] = [
    GCP_AUTH_PROVIDER_SCHEME_TYPE,
  ];

  private readonly agentIdentityProvider =
    new AgentIdentityCredentialsProvider();

  /**
   * Retrieves a credential for the scheme in `authConfig`.
   *
   * @param authConfig The auth configuration carrying the scheme.
   * @param context The context of the current tool call.
   * @returns The credential the delegate produced.
   * @throws Error If the scheme is not a `gcpAuthProviderScheme`, or if it
   *     names an IAM connector.
   */
  async getAuthCredential(
    authConfig: AuthConfig,
    context?: Context,
  ): Promise<AuthCredential> {
    const authScheme = authConfig.authScheme;
    if (!isGcpAuthProviderScheme(authScheme)) {
      throw new Error(`Expected GcpAuthProviderScheme, got ${authScheme.type}`);
    }

    if (CONNECTOR_RESOURCE_NAME_PATTERN.test(authScheme.name)) {
      throw new Error(
        'IAM Connector auth providers are not supported yet: ' +
          `'${authScheme.name}'.`,
      );
    }

    return this.agentIdentityProvider.getAuthCredential(authScheme, context);
  }
}
