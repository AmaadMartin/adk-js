/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main,
 * `tests/unittests/integrations/agent_identity/test_gcp_auth_provider.py`.
 * The `it()` names keep the Python test names.
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  Context,
  CredentialsProvider,
  GcpAuthProvider,
  GcpAuthProviderScheme,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {isGcpAuthProviderScheme} from '../../../src/integrations/agent_identity/gcp_auth_provider.js';
import {
  createAuthConfig,
  createAuthScheme,
  createContext,
} from './agent_identity_fixtures.js';

const CONNECTOR_NAME =
  'projects/test-project/locations/test-location/connectors/test-connector';

const CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'Bearer', credentials: {token: 'delegate-token'}},
};

/** Records the arguments the router forwarded. */
class RecordingProvider implements CredentialsProvider {
  readonly calls: Array<{
    authScheme: GcpAuthProviderScheme;
    context?: Context;
  }> = [];

  async getAuthCredential(
    authScheme: GcpAuthProviderScheme,
    context?: Context,
  ): Promise<AuthCredential> {
    this.calls.push({authScheme, context});
    return CREDENTIAL;
  }
}

describe('GcpAuthProvider', () => {
  it('test_supported_auth_schemes', () => {
    const provider = new GcpAuthProvider();

    expect(provider.supportedAuthSchemes).toContain('gcpAuthProviderScheme');
  });

  it('test_get_auth_credential_raises_error_for_invalid_auth_scheme', async () => {
    const provider = new GcpAuthProvider();
    const apiKeyScheme: AuthScheme = {
      type: 'apiKey',
      name: 'x-api-key',
      in: 'header',
    };

    await expect(
      provider.getAuthCredential(
        {authScheme: apiKeyScheme, credentialKey: 'k'},
        createContext(),
      ),
    ).rejects.toThrow(/Expected GcpAuthProviderScheme, got/);
  });

  it('test_get_auth_credential_routes_to_iam_connector_service_provider', async () => {
    const iamConnectorProvider = new RecordingProvider();
    const agentIdentityProvider = new RecordingProvider();
    const provider = new GcpAuthProvider({
      iamConnectorProvider,
      agentIdentityProvider,
    });
    const authScheme = createAuthScheme({name: CONNECTOR_NAME});
    const context = createContext();

    const result = await provider.getAuthCredential(
      createAuthConfig(authScheme),
      context,
    );

    expect(result).toEqual(CREDENTIAL);
    expect(iamConnectorProvider.calls).toEqual([{authScheme, context}]);
    expect(agentIdentityProvider.calls).toHaveLength(0);
  });

  it('test_get_auth_credential_routes_to_agent_identity_service_provider', async () => {
    const iamConnectorProvider = new RecordingProvider();
    const agentIdentityProvider = new RecordingProvider();
    const provider = new GcpAuthProvider({
      iamConnectorProvider,
      agentIdentityProvider,
    });
    const authScheme = createAuthScheme();
    const context = createContext();

    const result = await provider.getAuthCredential(
      createAuthConfig(authScheme),
      context,
    );

    expect(result).toEqual(CREDENTIAL);
    expect(agentIdentityProvider.calls).toEqual([{authScheme, context}]);
    expect(iamConnectorProvider.calls).toHaveLength(0);
  });

  it('rejects a connector resource name when no connector delegate is injected', async () => {
    const provider = new GcpAuthProvider();

    await expect(
      provider.getAuthCredential(
        createAuthConfig(createAuthScheme({name: CONNECTOR_NAME})),
        createContext(),
      ),
    ).rejects.toThrow(
      `IAM Connector auth providers are not supported yet; pass an ` +
        `iamConnectorProvider to handle '${CONNECTOR_NAME}'.`,
    );
  });
});

describe('isGcpAuthProviderScheme', () => {
  it('accepts a scheme with the right type and a name', () => {
    expect(isGcpAuthProviderScheme(createAuthScheme())).toBe(true);
  });

  it.each<[string, AuthScheme]>([
    ['an OpenAPI scheme', {type: 'apiKey', name: 'x-api-key', in: 'header'}],
    ['another custom scheme', {type: 'myProviderScheme'}],
    ['a scheme with no name', {type: 'gcpAuthProviderScheme'}],
  ])('rejects %s', (_label, candidate) => {
    expect(isGcpAuthProviderScheme(candidate)).toBe(false);
  });
});
