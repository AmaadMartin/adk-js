/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  BaseAuthProvider,
  createSession,
  CustomAuthConfig,
  getCustomSchemeCredential,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  registerAuthProvider,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'Bearer', credentials: {token: 'tok-123'}},
};

/**
 * A provider whose returned credential and declared scheme types are set per
 * test. `getAuthCredential` is a spy so call arguments can be asserted.
 *
 * `registerAuthProvider` writes to a process-wide registry with no reset, so
 * every test below claims a scheme type unique to itself.
 */
class FakeAuthProvider implements BaseAuthProvider {
  readonly getAuthCredential = vi
    .fn<BaseAuthProvider['getAuthCredential']>()
    .mockResolvedValue(CREDENTIAL);

  constructor(readonly supportedAuthSchemes: readonly string[]) {}
}

function makeAuthConfig(type: string): CustomAuthConfig {
  return {authScheme: {type}, credentialKey: `${type}_key`};
}

function makeContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'sess-1', appName: 'app', userId: 'user-1'}),
      pluginManager: new PluginManager([]),
    }),
  );
}

describe('getCustomSchemeCredential', () => {
  it('resolves the credential from the registered provider', async () => {
    registerAuthProvider(new FakeAuthProvider(['resolvedScheme']));

    await expect(
      getCustomSchemeCredential(makeAuthConfig('resolvedScheme')),
    ).resolves.toBe(CREDENTIAL);
  });

  it('throws naming the scheme type when no provider is registered', async () => {
    await expect(
      getCustomSchemeCredential(makeAuthConfig('unregisteredScheme')),
    ).rejects.toThrow(/unregisteredScheme.*registerAuthProvider/s);
  });

  it('throws when the provider resolves no credential', async () => {
    const provider = new FakeAuthProvider(['emptyScheme']);
    provider.getAuthCredential.mockResolvedValue(undefined);
    registerAuthProvider(provider);

    await expect(
      getCustomSchemeCredential(makeAuthConfig('emptyScheme')),
    ).rejects.toThrow('AuthProvider did not return a credential.');
  });

  it('propagates a provider rejection unchanged', async () => {
    const provider = new FakeAuthProvider(['failingScheme']);
    provider.getAuthCredential.mockRejectedValue(new Error('minting failed'));
    registerAuthProvider(provider);

    await expect(
      getCustomSchemeCredential(makeAuthConfig('failingScheme')),
    ).rejects.toThrow('minting failed');
  });

  it('passes the auth config and the context through to the provider', async () => {
    const provider = new FakeAuthProvider(['passthroughScheme']);
    registerAuthProvider(provider);
    const authConfig = makeAuthConfig('passthroughScheme');
    const context = makeContext();

    await getCustomSchemeCredential(authConfig, context);

    expect(provider.getAuthCredential).toHaveBeenCalledWith(
      authConfig,
      context,
    );
  });
});

describe('registerAuthProvider', () => {
  it('registers the provider under every supported scheme type', async () => {
    const provider = new FakeAuthProvider(['multiSchemeA', 'multiSchemeB']);

    registerAuthProvider(provider);

    await expect(
      getCustomSchemeCredential(makeAuthConfig('multiSchemeA')),
    ).resolves.toBe(CREDENTIAL);
    await expect(
      getCustomSchemeCredential(makeAuthConfig('multiSchemeB')),
    ).resolves.toBe(CREDENTIAL);
  });

  it('makes the provider resolvable through the default registry', async () => {
    const provider = new FakeAuthProvider(['defaultRegistryScheme']);

    registerAuthProvider(provider);

    await getCustomSchemeCredential(makeAuthConfig('defaultRegistryScheme'));
    expect(provider.getAuthCredential).toHaveBeenCalledOnce();
  });

  it('keeps the first provider and warns when a second one claims the scheme', async () => {
    const first = new FakeAuthProvider(['contestedScheme']);
    const second = new FakeAuthProvider(['contestedScheme']);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    registerAuthProvider(first);
    registerAuthProvider(second);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('contestedScheme'),
    );
    await getCustomSchemeCredential(makeAuthConfig('contestedScheme'));
    expect(first.getAuthCredential).toHaveBeenCalledOnce();
    expect(second.getAuthCredential).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not warn when the same provider instance registers twice', () => {
    const provider = new FakeAuthProvider(['idempotentScheme']);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    registerAuthProvider(provider);
    registerAuthProvider(provider);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
