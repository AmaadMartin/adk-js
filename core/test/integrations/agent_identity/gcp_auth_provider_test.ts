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
  isGcpAuthProviderScheme,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
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

/** What a credentials service returns to produce {@link CREDENTIAL}. */
const SERVICE_CREDENTIALS = {
  header: 'Authorization: Bearer',
  token: 'delegate-token',
};

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: () =>
      Promise.resolve({
        getRequestHeaders: () =>
          Promise.resolve(new Headers({authorization: 'Bearer fake-token'})),
      }),
  })),
}));

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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('routes a connector name to the default connector delegate', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({done: true, response: SERVICE_CREDENTIALS}),
        {
          status: 200,
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new GcpAuthProvider();

    const credential = await provider.getAuthCredential(
      createAuthConfig(createAuthScheme({name: CONNECTOR_NAME})),
      createContext(),
    );

    expect(credential).toEqual(CREDENTIAL);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://iamconnectorcredentials.googleapis.com/v1alpha/` +
        `${CONNECTOR_NAME}/credentials:retrieve`,
    );
  });

  it('routes an auth provider name to the default Agent Identity delegate', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({success: SERVICE_CREDENTIALS}), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const authScheme = createAuthScheme();
    const provider = new GcpAuthProvider();

    const credential = await provider.getAuthCredential(
      createAuthConfig(authScheme),
      createContext(),
    );

    expect(credential).toEqual(CREDENTIAL);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://agentidentitycredentials.googleapis.com/v1/` +
        `${authScheme.name}/credentials:retrieve`,
    );
  });
});

describe('isGcpAuthProviderScheme', () => {
  it('accepts a scheme with the right type and a name', () => {
    expect(isGcpAuthProviderScheme(createAuthScheme())).toBe(true);
  });

  it.each<[string, AuthScheme]>([
    ['an API key scheme', {type: 'apiKey', name: 'x-api-key', in: 'header'}],
    ['an HTTP scheme', {type: 'http', scheme: 'bearer'}],
    [
      'an OpenID Connect scheme',
      {
        type: 'openIdConnect',
        openIdConnectUrl: 'https://example.com/.well-known',
      },
    ],
  ])('rejects %s', (_label, candidate) => {
    expect(isGcpAuthProviderScheme(candidate)).toBe(false);
  });
});
