/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthProviderRegistry, AuthScheme} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  describeScheme,
  GcpAuthProvider,
} from '../../../src/integrations/agent_identity/gcp_auth_provider.js';
import {
  GCP_AUTH_PROVIDER_SCHEME_TYPE,
  GcpAuthProviderScheme,
} from '../../../src/integrations/agent_identity/gcp_auth_provider_scheme.js';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue({
      getRequestHeaders: vi
        .fn()
        .mockResolvedValue({'Authorization': 'Bearer fake-token'}),
      credentials: {},
    }),
  })),
}));

const AGENT_IDENTITY_HOST = 'https://agentidentitycredentials.googleapis.com';
const IAM_CONNECTOR_URL =
  'https://iamconnectorcredentials.googleapis.com/v1alpha/projects/p/locations/l/connectors/c/credentials:retrieve';

const CONTEXT = {userId: 'user'};

function scheme(name: string): GcpAuthProviderScheme {
  return {type: GCP_AUTH_PROVIDER_SCHEME_TYPE, name};
}

/** The URL of the single request the provider made. */
function requestedUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const url: unknown = fetchMock.mock.calls[0][0];
  if (typeof url !== 'string') {
    expect.fail('expected the provider to fetch a string URL');
  }
  return url;
}

describe('GcpAuthProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let provider: GcpAuthProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    // Both services report an immediate success, each in its own shape: the
    // Agent Identity service nests it under `success`, the IAM connector
    // returns a completed operation with a `response`.
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: {header: 'Authorization: Bearer', token: 'test-token'},
        done: true,
        response: {header: 'Authorization: Bearer', token: 'test-token'},
      }),
    });
    global.fetch = fetchMock;
    provider = new GcpAuthProvider();
  });

  it('rejects a scheme that is not a GcpAuthProviderScheme', async () => {
    const authScheme: AuthScheme = {
      type: 'apiKey',
      name: 'testKey',
      in: 'header',
    };

    await expect(
      provider.getAuthCredential({authScheme, credentialKey: 'key'}, CONTEXT),
    ).rejects.toThrow('Expected GcpAuthProviderScheme, got apiKey');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes a connector resource name to the IAM connector service', async () => {
    const credential = await provider.getAuthCredential(
      {authScheme: scheme('projects/p/locations/l/connectors/c')},
      CONTEXT,
    );

    expect(credential?.http?.credentials.token).toBe('test-token');
    expect(requestedUrl(fetchMock)).toBe(IAM_CONNECTOR_URL);
  });

  it('routes an auth provider resource name to the Agent Identity service', async () => {
    const credential = await provider.getAuthCredential(
      {authScheme: scheme('projects/p/locations/l/authProviders/a')},
      CONTEXT,
    );

    expect(credential?.http?.credentials.token).toBe('test-token');
    expect(requestedUrl(fetchMock)).toBe(
      `${AGENT_IDENTITY_HOST}/v1/projects/p/locations/l/authProviders/a/credentials:retrieve`,
    );
  });

  it('does not treat a longer connector path as a connector', async () => {
    await provider.getAuthCredential(
      {authScheme: scheme('projects/p/locations/l/connectors/c/keys/k')},
      CONTEXT,
    );

    expect(requestedUrl(fetchMock)).toBe(
      `${AGENT_IDENTITY_HOST}/v1/projects/p/locations/l/connectors/c/keys/k/credentials:retrieve`,
    );
  });

  it('forwards the context to the selected backend', async () => {
    await provider.getAuthCredential(
      {authScheme: scheme('projects/p/locations/l/connectors/c')},
      {userId: 'other-user'},
    );

    expect(fetchMock).toHaveBeenCalledWith(
      IAM_CONNECTOR_URL,
      expect.objectContaining({
        body: expect.stringContaining('"userId":"other-user"'),
      }),
    );
  });

  it('is resolvable from an AuthProviderRegistry by scheme type', () => {
    const registry = new AuthProviderRegistry();
    registry.register(GCP_AUTH_PROVIDER_SCHEME_TYPE, provider);

    expect(
      registry.getProvider(scheme('projects/p/locations/l/authProviders/a')),
    ).toBe(provider);
  });
});

describe('describeScheme', () => {
  it('reports the scheme type when it is a string', () => {
    expect(describeScheme({type: 'apiKey'})).toBe('apiKey');
  });

  it('reports the value kind when there is no type at all', () => {
    expect(describeScheme(undefined)).toBe('undefined');
    expect(describeScheme('gcpAuthProviderScheme')).toBe('string');
    expect(describeScheme({})).toBe('object');
  });

  it('reports the value kind when the type is not a string', () => {
    expect(describeScheme({type: 42})).toBe('object');
  });

  it('does not disclose the rest of the scheme', () => {
    expect(
      describeScheme({type: 'apiKey', name: 'secret-provider-name'}),
    ).not.toContain('secret-provider-name');
  });
});
