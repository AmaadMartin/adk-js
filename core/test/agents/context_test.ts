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
  BaseMemoryService,
  Context,
  InMemoryCredentialService,
  InMemoryMemoryService,
  InvocationContext,
  LoopAgent,
  PluginManager,
  Session,
  createEvent,
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

function createMemoryContext(memoryService?: BaseMemoryService): {
  context: Context;
  session: Session;
} {
  const session = createSession({
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
    events: [
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'my favourite colour is teal'}]},
      }),
    ],
  });
  const context = new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LoopAgent({name: 'root'}),
      session,
      pluginManager: new PluginManager(),
      memoryService,
    }),
  });
  return {context, session};
}

function createStubMemoryService() {
  return {
    addSessionToMemory: vi.fn<BaseMemoryService['addSessionToMemory']>(
      async () => {},
    ),
    searchMemory: vi.fn<BaseMemoryService['searchMemory']>(async () => ({
      memories: [],
    })),
  };
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

describe('Context.addSessionToMemory', () => {
  it('forwards the invocation session to the memory service', async () => {
    const service = createStubMemoryService();
    const {context, session} = createMemoryContext(service);

    await context.addSessionToMemory();

    expect(service.addSessionToMemory).toHaveBeenCalledTimes(1);
    expect(service.addSessionToMemory.mock.calls[0][0]).toBe(session);
  });

  it('throws when no memory service is configured', () => {
    const {context} = createMemoryContext();

    expect(() => context.addSessionToMemory()).toThrowError(
      'Memory service is not initialized.',
    );
  });

  it('propagates an error raised by the service', async () => {
    const service = createStubMemoryService();
    service.addSessionToMemory.mockRejectedValue(
      new Error('memory bank unavailable'),
    );
    const {context} = createMemoryContext(service);

    await expect(context.addSessionToMemory()).rejects.toThrow(
      'memory bank unavailable',
    );
  });
});

describe('Context memory round trip through InMemoryMemoryService', () => {
  it('searches back an event from the session a previous add stored', async () => {
    const {context} = createMemoryContext(new InMemoryMemoryService());

    await context.addSessionToMemory();

    const response = await context.searchMemory('teal');
    expect(response.memories).toHaveLength(1);
    expect(response.memories[0].content.parts?.[0].text).toBe(
      'my favourite colour is teal',
    );
  });

  it('finds nothing before the session is added', async () => {
    const {context} = createMemoryContext(new InMemoryMemoryService());

    expect((await context.searchMemory('teal')).memories).toEqual([]);
  });
});

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
