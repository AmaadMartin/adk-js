/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthenticatedRunAsyncToolRequest,
  AuthScheme,
  BaseAgent,
  BaseAuthenticatedTool,
  Context,
  createSession,
  InMemoryCredentialService,
  InvocationContext,
  PENDING_USER_AUTHORIZATION,
  PluginManager,
  ToolCredentialManager,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const OAUTH2_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://example.com/oauth2/authorize',
      tokenUrl: 'https://example.com/oauth2/token',
      scopes: {read: 'Read access'},
    },
  },
};

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Api-Key',
};

const OAUTH2_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {
    clientId: 'client-id',
    clientSecret: 'client-secret',
  },
};

/** A tool that records what its body was called with. */
class RecordingAuthenticatedTool extends BaseAuthenticatedTool {
  lastRequest?: AuthenticatedRunAsyncToolRequest;
  callCount = 0;
  result: unknown = 'test_result';
  failure?: Error;

  protected override async runAsyncImpl(
    request: AuthenticatedRunAsyncToolRequest,
  ): Promise<unknown> {
    this.callCount += 1;
    this.lastRequest = request;
    if (this.failure) {
      throw this.failure;
    }
    return this.result;
  }

  /** Replaces the resolver, the way an embedder or a test would. */
  useCredentialManager(manager: ToolCredentialManager): void {
    this.credentialManager = manager;
  }
}

function createFakeManager(
  credential: AuthCredential | undefined,
): ToolCredentialManager {
  return {
    getAuthCredential: vi.fn(async () => credential),
    requestCredential: vi.fn(async () => {}),
  };
}

function createInvocationContext(options?: {
  credentialService?: InMemoryCredentialService;
  userId?: string;
}): InvocationContext {
  return new InvocationContext({
    invocationId: 'invocation-1',
    agent: {name: 'test-agent'} as BaseAgent,
    session: createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: options?.userId ?? 'user-1',
    }),
    pluginManager: new PluginManager([]),
    credentialService: options?.credentialService,
  });
}

function createToolContext(options?: {
  credentialService?: InMemoryCredentialService;
  userId?: string;
}): Context {
  return new Context({
    invocationContext: createInvocationContext(options),
    functionCallId: 'call-1',
  });
}

describe('BaseAuthenticatedTool', () => {
  let toolContext: Context;

  beforeEach(() => {
    toolContext = createToolContext();
  });

  it('keeps the name and description and consults the manager', async () => {
    const tool = new RecordingAuthenticatedTool({
      name: 'test_tool',
      description: 'Test description',
      authConfig: {
        authScheme: OAUTH2_SCHEME,
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: 'test_tool',
      },
    });
    const manager = createFakeManager({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'resolved',
    });
    tool.useCredentialManager(manager);

    await tool.runAsync({args: {}, toolContext});

    expect(tool.name).toBe('test_tool');
    expect(tool.description).toBe('Test description');
    expect(manager.getAuthCredential).toHaveBeenCalledOnce();
  });

  it('runs unauthenticated when no auth config is given', async () => {
    const tool = new RecordingAuthenticatedTool({
      name: 'test_auth_tool',
      description: 'Test authenticated tool',
    });
    const credentialService = new InMemoryCredentialService();
    const loadSpy = vi.spyOn(credentialService, 'loadCredential');
    const context = createToolContext({credentialService});

    const result = await tool.runAsync({
      args: {param1: 'value1'},
      toolContext: context,
    });

    expect(result).toBe('test_result');
    expect(tool.callCount).toBe(1);
    expect(tool.lastRequest?.args).toEqual({param1: 'value1'});
    expect(tool.lastRequest?.toolContext).toBe(context);
    expect(tool.lastRequest?.credential).toBeUndefined();
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it('runs unauthenticated when the auth config carries no scheme', async () => {
    // An auth config read from a config file can arrive without a scheme.
    const authConfigWithoutScheme = {
      credentialKey: 'test_tool',
    } as AuthConfig;
    const tool = new RecordingAuthenticatedTool({
      name: 'test_auth_tool',
      description: 'Test authenticated tool',
      authConfig: authConfigWithoutScheme,
    });

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toBe('test_result');
    expect(tool.lastRequest?.credential).toBeUndefined();
  });

  it('passes the resolved credential to the body', async () => {
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'token'},
    };
    const tool = new RecordingAuthenticatedTool({
      name: 'test_tool',
      description: 'Test description',
      authConfig: {
        authScheme: OAUTH2_SCHEME,
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: 'test_tool',
      },
    });
    const manager = createFakeManager(credential);
    tool.useCredentialManager(manager);

    const result = await tool.runAsync({
      args: {param1: 'value1'},
      toolContext,
    });

    expect(result).toBe('test_result');
    expect(tool.lastRequest?.args).toEqual({param1: 'value1'});
    expect(tool.lastRequest?.toolContext).toBe(toolContext);
    expect(tool.lastRequest?.credential).toBe(credential);
    expect(manager.getAuthCredential).toHaveBeenCalledExactlyOnceWith(
      toolContext,
    );
  });

  it('returns the default pending response and skips the body', async () => {
    const tool = new RecordingAuthenticatedTool({
      name: 'test_tool',
      description: 'Test description',
      authConfig: {
        authScheme: OAUTH2_SCHEME,
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: 'test_tool',
      },
    });
    const manager = createFakeManager(undefined);
    tool.useCredentialManager(manager);

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toBe('Pending User Authorization.');
    expect(result).toBe(PENDING_USER_AUTHORIZATION);
    expect(tool.callCount).toBe(0);
    expect(manager.getAuthCredential).toHaveBeenCalledExactlyOnceWith(
      toolContext,
    );
    expect(manager.requestCredential).toHaveBeenCalledExactlyOnceWith(
      toolContext,
    );
  });

  it('returns a configured object response verbatim', async () => {
    const responseForAuthRequired = {
      status: 'authentication_required',
      message: 'Please login',
    };
    const tool = new RecordingAuthenticatedTool({
      name: 'test_tool',
      description: 'Test description',
      authConfig: {
        authScheme: OAUTH2_SCHEME,
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: 'test_tool',
      },
      responseForAuthRequired,
    });
    tool.useCredentialManager(createFakeManager(undefined));

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toBe(responseForAuthRequired);
    expect(tool.callCount).toBe(0);
  });

  it('returns a configured string response verbatim', async () => {
    const tool = new RecordingAuthenticatedTool({
      name: 'test_tool',
      description: 'Test description',
      authConfig: {
        authScheme: OAUTH2_SCHEME,
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: 'test_tool',
      },
      responseForAuthRequired: 'Custom authentication required message',
    });
    tool.useCredentialManager(createFakeManager(undefined));

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toBe('Custom authentication required message');
    expect(tool.callCount).toBe(0);
  });

  it('treats an empty string response as unset', async () => {
    const tool = new RecordingAuthenticatedTool({
      name: 'test_tool',
      description: 'Test description',
      authConfig: {
        authScheme: OAUTH2_SCHEME,
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: 'test_tool',
      },
      responseForAuthRequired: '',
    });
    tool.useCredentialManager(createFakeManager(undefined));

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toBe(PENDING_USER_AUTHORIZATION);
  });

  it('treats an empty object response as unset', async () => {
    const tool = new RecordingAuthenticatedTool({
      name: 'test_tool',
      description: 'Test description',
      authConfig: {
        authScheme: OAUTH2_SCHEME,
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: 'test_tool',
      },
      responseForAuthRequired: {},
    });
    tool.useCredentialManager(createFakeManager(undefined));

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toBe(PENDING_USER_AUTHORIZATION);
  });

  it('propagates a failure from the body', async () => {
    const tool = new RecordingAuthenticatedTool({
      name: 'test_tool',
      description: 'Test description',
      authConfig: {
        authScheme: OAUTH2_SCHEME,
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: 'test_tool',
      },
    });
    tool.failure = new Error('Implementation failed');
    tool.useCredentialManager(
      createFakeManager({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'resolved',
      }),
    );

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Implementation failed',
    );
  });

  it('propagates a failure from the credential manager', async () => {
    const tool = new RecordingAuthenticatedTool({
      name: 'test_tool',
      description: 'Test description',
      authConfig: {
        authScheme: OAUTH2_SCHEME,
        rawAuthCredential: OAUTH2_CREDENTIAL,
        credentialKey: 'test_tool',
      },
    });
    tool.useCredentialManager({
      getAuthCredential: vi.fn(async () => {
        throw new Error('Credential service error');
      }),
      requestCredential: vi.fn(async () => {}),
    });

    await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
      'Credential service error',
    );
    expect(tool.callCount).toBe(0);
  });

  it('passes varied argument shapes through unchanged', async () => {
    const tool = new RecordingAuthenticatedTool({
      name: 'test_auth_tool',
      description: 'Test authenticated tool',
    });

    await tool.runAsync({args: {}, toolContext});
    expect(tool.lastRequest?.args).toEqual({});

    const complexArgs = {
      stringParam: 'test',
      numberParam: 42,
      listParam: [1, 2, 3],
      objectParam: {nested: 'value'},
    };
    await tool.runAsync({args: complexArgs, toolContext});
    expect(tool.lastRequest?.args).toEqual(complexArgs);
  });

  it('returns varied body results unchanged', async () => {
    const tool = new RecordingAuthenticatedTool({
      name: 'test_auth_tool',
      description: 'Test authenticated tool',
    });

    tool.result = undefined;
    expect(await tool.runAsync({args: {}, toolContext})).toBeUndefined();

    tool.result = {key: 'value'};
    expect(await tool.runAsync({args: {}, toolContext})).toEqual({
      key: 'value',
    });

    tool.result = [1, 2, 3];
    expect(await tool.runAsync({args: {}, toolContext})).toEqual([1, 2, 3]);
  });

  it('records a requested auth config on the event actions', async () => {
    const authConfig: AuthConfig = {
      authScheme: OAUTH2_SCHEME,
      rawAuthCredential: OAUTH2_CREDENTIAL,
      credentialKey: 'test_tool',
    };
    const tool = new RecordingAuthenticatedTool({
      name: 'test_tool',
      description: 'Test description',
      authConfig,
    });

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toBe(PENDING_USER_AUTHORIZATION);
    const requested = toolContext.eventActions.requestedAuthConfigs['call-1'];
    expect(requested.credentialKey).toBe('test_tool');
    expect(requested.exchangedAuthCredential?.oauth2?.authUri).toBeDefined();
  });
});

describe('BaseAuthenticatedTool with a real CredentialManager', () => {
  it('resolves an API key credential and runs the body', async () => {
    const credentialService = new InMemoryCredentialService();
    const context = createToolContext({credentialService});
    const tool = new RecordingAuthenticatedTool({
      name: 'api_key_tool',
      description: 'Reads an API key',
      authConfig: {
        authScheme: API_KEY_SCHEME,
        rawAuthCredential: {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'secret-key',
        },
        credentialKey: 'api_key_tool',
      },
    });

    const result = await tool.runAsync({
      args: {q: 'hello'},
      toolContext: context,
    });

    expect(result).toBe('test_result');
    expect(tool.lastRequest?.credential?.apiKey).toBe('secret-key');
  });

  it('asks for authorization, then runs the body once the credential is stored', async () => {
    const credentialService = new InMemoryCredentialService();
    const authConfig: AuthConfig = {
      authScheme: OAUTH2_SCHEME,
      rawAuthCredential: OAUTH2_CREDENTIAL,
      credentialKey: 'oauth_tool',
    };
    const tool = new RecordingAuthenticatedTool({
      name: 'oauth_tool',
      description: 'Calls an OAuth2 API',
      authConfig,
    });
    const firstContext = createToolContext({credentialService});

    const pending = await tool.runAsync({args: {}, toolContext: firstContext});

    expect(pending).toBe(PENDING_USER_AUTHORIZATION);
    expect(tool.callCount).toBe(0);
    expect(
      firstContext.eventActions.requestedAuthConfigs['call-1'],
    ).toBeDefined();

    const exchangedCredential: AuthCredential = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: 'access-token', expiresAt: 9_999_999_999},
    };
    const secondContext = createToolContext({credentialService});
    await credentialService.saveCredential(
      {...authConfig, exchangedAuthCredential: exchangedCredential},
      secondContext,
    );

    const result = await tool.runAsync({args: {}, toolContext: secondContext});

    expect(result).toBe('test_result');
    expect(tool.callCount).toBe(1);
    expect(tool.lastRequest?.credential?.oauth2?.accessToken).toBe(
      'access-token',
    );
  });
});
