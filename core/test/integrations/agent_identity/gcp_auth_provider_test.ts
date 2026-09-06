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

import {AuthCredentialTypes, AuthScheme, GcpAuthProvider} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {isGcpAuthProviderScheme} from '../../../src/integrations/agent_identity/gcp_auth_provider.js';
import {
  AUTH_PROVIDER_NAME,
  bearerSuccess,
  createAuthConfig,
  createAuthScheme,
  createContext,
} from './agent_identity_fixtures.js';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: () =>
      Promise.resolve({
        getRequestHeaders: () =>
          Promise.resolve(new Headers({authorization: 'Bearer fake-token'})),
      }),
  })),
}));

const CONNECTOR_NAME =
  'projects/test-project/locations/test-location/connectors/test-connector';

const RETRIEVE_URL =
  `https://agentidentitycredentials.googleapis.com/v1/` +
  `${AUTH_PROVIDER_NAME}/credentials:retrieve`;

const CONNECTOR_RETRIEVE_URL =
  `https://iamconnectorcredentials.googleapis.com/v1alpha/` +
  `${CONNECTOR_NAME}/credentials:retrieve`;

describe('GcpAuthProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

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
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          done: true,
          response: {header: 'Authorization: Bearer', token: 'connector-token'},
        }),
        {status: 200},
      ),
    );
    const provider = new GcpAuthProvider();

    const result = await provider.getAuthCredential(
      createAuthConfig(createAuthScheme({name: CONNECTOR_NAME})),
      createContext(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(CONNECTOR_RETRIEVE_URL);
    expect(result).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Bearer', credentials: {token: 'connector-token'}},
    });
  });

  it('test_get_auth_credential_routes_to_agent_identity_service_provider', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(bearerSuccess('routed-token')), {
        status: 200,
      }),
    );
    const provider = new GcpAuthProvider();

    const result = await provider.getAuthCredential(
      createAuthConfig(createAuthScheme()),
      createContext(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(RETRIEVE_URL);
    expect(result).toEqual({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'Bearer', credentials: {token: 'routed-token'}},
    });
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
    ['another custom scheme', {type: 'myProviderScheme'}],
    ['a scheme with no name', {type: 'gcpAuthProviderScheme'}],
  ])('rejects %s', (_label, candidate) => {
    expect(isGcpAuthProviderScheme(candidate)).toBe(false);
  });
});
