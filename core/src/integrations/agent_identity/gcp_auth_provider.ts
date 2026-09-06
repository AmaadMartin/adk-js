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
import {GcpAuthProviderScheme} from '../agent_registry/types.js';
import {
  AgentIdentityCredentialsProvider,
  CredentialsProvider,
} from './agent_identity_credentials_provider.js';

/** The scheme `type` this provider is registered under. */
export const GCP_AUTH_PROVIDER_SCHEME_TYPE = 'gcpAuthProviderScheme';

/** Legacy resource names that name an IAM connector rather than a provider. */
const CONNECTOR_RESOURCE_NAME_PATTERN =
  /^projects\/[^/]+\/locations\/[^/]+\/connectors\/[^/]+$/;

/** Options for {@link GcpAuthProvider}. */
export interface GcpAuthProviderOptions {
  /** Serves auth provider resource names. Defaults to the Agent Identity one. */
  agentIdentityProvider?: CredentialsProvider;

  /**
   * Serves IAM connector resource names. There is no default: adk-js has no
   * IAM Connector Credentials client yet.
   */
  iamConnectorProvider?: CredentialsProvider;
}

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

  private readonly agentIdentityProvider: CredentialsProvider;
  private readonly iamConnectorProvider?: CredentialsProvider;

  constructor(options?: GcpAuthProviderOptions) {
    this.agentIdentityProvider =
      options?.agentIdentityProvider ?? new AgentIdentityCredentialsProvider();
    this.iamConnectorProvider = options?.iamConnectorProvider;
  }

  /**
   * Retrieves a credential for the scheme in `authConfig`.
   *
   * @param authConfig The auth configuration carrying the scheme.
   * @param context The context of the current tool call.
   * @returns The credential the delegate produced.
   * @throws Error If the scheme is not a `gcpAuthProviderScheme`, or if it
   *     names an IAM connector and no connector delegate was supplied.
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
      if (!this.iamConnectorProvider) {
        throw new Error(
          'IAM Connector auth providers are not supported yet; pass an ' +
            `iamConnectorProvider to handle '${authScheme.name}'.`,
        );
      }
      return this.iamConnectorProvider.getAuthCredential(authScheme, context);
    }

    return this.agentIdentityProvider.getAuthCredential(authScheme, context);
  }
}
