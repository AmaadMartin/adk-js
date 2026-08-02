/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthProviderRegistry,
  AuthScheme,
  GCP_AUTH_PROVIDER_SCHEME_TYPE,
  GcpAuthProviderScheme,
  isGcpAuthProviderScheme,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {AgentIdentityCredentialsProvider} from '../../../src/integrations/agent_identity/agent_identity_credentials_provider.js';
import {
  describeScheme,
  GcpAuthProvider,
} from '../../../src/integrations/agent_identity/gcp_auth_provider.js';
import {IamConnectorCredentialsProvider} from '../../../src/integrations/agent_identity/iam_connector_credentials_provider.js';

const CONTEXT = {userId: 'user'};

function scheme(name: string): GcpAuthProviderScheme {
  return {type: GCP_AUTH_PROVIDER_SCHEME_TYPE, name};
}

describe('GcpAuthProvider', () => {
  let agentIdentityClient: {retrieveCredentials: ReturnType<typeof vi.fn>};
  let iamConnectorClient: {retrieveCredentials: ReturnType<typeof vi.fn>};
  let provider: GcpAuthProvider;

  beforeEach(() => {
    agentIdentityClient = {
      retrieveCredentials: vi.fn().mockResolvedValue({
        success: {header: 'Authorization: Bearer', token: 'agent-identity'},
      }),
    };
    iamConnectorClient = {
      retrieveCredentials: vi.fn().mockResolvedValue({
        done: true,
        response: {header: 'Authorization: Bearer', token: 'iam-connector'},
      }),
    };
    provider = new GcpAuthProvider({
      agentIdentityProvider: new AgentIdentityCredentialsProvider(
        agentIdentityClient,
      ),
      iamConnectorProvider: new IamConnectorCredentialsProvider(
        iamConnectorClient,
      ),
    });
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
    expect(agentIdentityClient.retrieveCredentials).not.toHaveBeenCalled();
    expect(iamConnectorClient.retrieveCredentials).not.toHaveBeenCalled();
  });

  it('routes a connector resource name to the IAM connector backend', async () => {
    const credential = await provider.getAuthCredential(
      {authScheme: scheme('projects/p/locations/l/connectors/c')},
      CONTEXT,
    );

    expect(credential?.http?.credentials.token).toBe('iam-connector');
    expect(iamConnectorClient.retrieveCredentials).toHaveBeenCalledTimes(1);
    expect(agentIdentityClient.retrieveCredentials).not.toHaveBeenCalled();
  });

  it('routes an auth provider resource name to the Agent Identity backend', async () => {
    const credential = await provider.getAuthCredential(
      {authScheme: scheme('projects/p/locations/l/authProviders/a')},
      CONTEXT,
    );

    expect(credential?.http?.credentials.token).toBe('agent-identity');
    expect(agentIdentityClient.retrieveCredentials).toHaveBeenCalledTimes(1);
    expect(iamConnectorClient.retrieveCredentials).not.toHaveBeenCalled();
  });

  it('does not treat a longer connector path as a connector', async () => {
    const credential = await provider.getAuthCredential(
      {authScheme: scheme('projects/p/locations/l/connectors/c/keys/k')},
      CONTEXT,
    );

    expect(credential?.http?.credentials.token).toBe('agent-identity');
    expect(iamConnectorClient.retrieveCredentials).not.toHaveBeenCalled();
  });

  it('forwards the context to the selected backend', async () => {
    await provider.getAuthCredential(
      {authScheme: scheme('projects/p/locations/l/connectors/c')},
      {userId: 'other-user'},
    );

    expect(iamConnectorClient.retrieveCredentials).toHaveBeenCalledWith(
      'projects/p/locations/l/connectors/c',
      expect.objectContaining({userId: 'other-user'}),
    );
  });

  it('builds real backends when none are injected', () => {
    expect(() => new GcpAuthProvider()).not.toThrow();
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

describe('isGcpAuthProviderScheme', () => {
  it('accepts a well-formed scheme', () => {
    expect(isGcpAuthProviderScheme(scheme('some-provider'))).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'gcpAuthProviderScheme'],
    ['another scheme type', {type: 'apiKey', name: 'testKey'}],
    ['a scheme with no name', {type: GCP_AUTH_PROVIDER_SCHEME_TYPE}],
    [
      'a scheme whose name is not a string',
      {type: GCP_AUTH_PROVIDER_SCHEME_TYPE, name: 42},
    ],
    ['an object with no type', {name: 'some-provider'}],
  ])('rejects %s', (_label, value) => {
    expect(isGcpAuthProviderScheme(value)).toBe(false);
  });
});
