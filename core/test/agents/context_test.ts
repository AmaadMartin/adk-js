/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  BaseCredentialService,
  Context,
  InMemoryCredentialService,
  InvocationContext,
  LoopAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Api-Key',
};

const CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'secret',
};

function createAuthConfig(
  credentialKey: string,
  exchangedAuthCredential?: AuthCredential,
): AuthConfig {
  return {credentialKey, authScheme: API_KEY_SCHEME, exchangedAuthCredential};
}

function createContext(credentialService?: BaseCredentialService): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LoopAgent({name: 'root'}),
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager(),
      credentialService,
    }),
  });
}

function createStubCredentialService(loaded?: AuthCredential) {
  return {
    loadCredential: vi.fn<BaseCredentialService['loadCredential']>(
      async () => loaded,
    ),
    saveCredential: vi.fn<BaseCredentialService['saveCredential']>(
      async () => {},
    ),
  };
}

describe('Context.saveCredential', () => {
  it('forwards the auth config and this context to the service', async () => {
    const service = createStubCredentialService();
    const context = createContext(service);
    const authConfig = createAuthConfig('key1', CREDENTIAL);

    await context.saveCredential(authConfig);

    expect(service.saveCredential).toHaveBeenCalledWith(authConfig, context);
  });

  it('rejects when no credential service is configured', async () => {
    const context = createContext();

    await expect(
      context.saveCredential(createAuthConfig('key1', CREDENTIAL)),
    ).rejects.toThrow('Credential service is not initialized.');
  });

  it('propagates an error raised by the service', async () => {
    const service = createStubCredentialService();
    service.saveCredential.mockRejectedValue(new Error('store unavailable'));
    const context = createContext(service);

    await expect(
      context.saveCredential(createAuthConfig('key1', CREDENTIAL)),
    ).rejects.toThrow('store unavailable');
  });
});

describe('Context.loadCredential', () => {
  it('forwards the auth config and this context, and returns the credential', async () => {
    const service = createStubCredentialService(CREDENTIAL);
    const context = createContext(service);
    const authConfig = createAuthConfig('key1');

    const loaded = await context.loadCredential(authConfig);

    expect(service.loadCredential).toHaveBeenCalledWith(authConfig, context);
    expect(loaded).toBe(CREDENTIAL);
  });

  it('rejects when no credential service is configured', async () => {
    const context = createContext();

    await expect(
      context.loadCredential(createAuthConfig('key1')),
    ).rejects.toThrow('Credential service is not initialized.');
  });

  it('propagates an error raised by the service', async () => {
    const service = createStubCredentialService();
    service.loadCredential.mockRejectedValue(new Error('store unavailable'));
    const context = createContext(service);

    await expect(
      context.loadCredential(createAuthConfig('key1')),
    ).rejects.toThrow('store unavailable');
  });
});

describe('Context credential round trip through InMemoryCredentialService', () => {
  it('loads back the credential a previous save stored', async () => {
    const context = createContext(new InMemoryCredentialService());
    const authConfig = createAuthConfig('key1', CREDENTIAL);

    await context.saveCredential(authConfig);

    expect(await context.loadCredential(authConfig)).toEqual(CREDENTIAL);
  });

  it('resolves undefined for a credential key that was never saved', async () => {
    const context = createContext(new InMemoryCredentialService());

    expect(
      await context.loadCredential(createAuthConfig('unknown')),
    ).toBeUndefined();
  });
});
