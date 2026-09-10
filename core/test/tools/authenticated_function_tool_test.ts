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
  AuthenticatedFunctionTool,
  BaseCredentialService,
  Context,
  InMemoryCredentialService,
  InvocationContext,
  PENDING_USER_AUTHORIZATION,
  PluginManager,
  RunAsyncToolRequest,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v3';

const API_KEY_SCHEME = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Api-Key',
} as const;
const OAUTH2_SCHEME = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://provider.example.com/authorize',
      tokenUrl: 'https://provider.example.com/token',
      scopes: {read: 'Read access'},
    },
  },
} as const;

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'configured-api-key',
};

/** A credential service that never holds anything. */
class EmptyCredentialService implements BaseCredentialService {
  async loadCredential(): Promise<AuthCredential | undefined> {
    return undefined;
  }

  async saveCredential(): Promise<void> {}
}

/** A credential service that always answers with one OAuth2 access token. */
class StaticCredentialService implements BaseCredentialService {
  constructor(private readonly accessToken: string) {}

  async loadCredential(): Promise<AuthCredential | undefined> {
    return {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {accessToken: this.accessToken},
    };
  }

  async saveCredential(): Promise<void> {}
}

function createToolContext(
  credentialService?: BaseCredentialService,
  functionCallId = 'call-1',
): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({
      id: 'session-id',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
    credentialService,
  });

  return new Context({invocationContext, functionCallId});
}

function createApiKeyAuthConfig(): AuthConfig {
  return {
    authScheme: API_KEY_SCHEME as AuthScheme,
    rawAuthCredential: API_KEY_CREDENTIAL,
    credentialKey: 'api-key',
  };
}

function createOAuth2AuthConfig(): AuthConfig {
  return {
    authScheme: OAUTH2_SCHEME as AuthScheme,
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    },
    credentialKey: 'oauth-key',
  };
}

describe('AuthenticatedFunctionTool', () => {
  describe('without authentication', () => {
    it('runs a synchronous function with no credential', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'sync_tool',
        description: 'A synchronous tool.',
        execute: (_input, _toolContext, credential) => `got:${credential}`,
      });

      expect(
        await tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).toBe('got:undefined');
    });

    it('runs an asynchronous function with no credential', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'async_tool',
        description: 'An asynchronous tool.',
        execute: async (_input, _toolContext, credential) => credential,
      });

      expect(
        await tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).toBeUndefined();
    });

    it('takes its name from the function when none is given', () => {
      async function listRepos() {
        return [];
      }
      const tool = new AuthenticatedFunctionTool({
        description: 'Lists repositories.',
        execute: listRepos,
      });

      expect(tool.name).toBe('listRepos');
    });
  });

  describe('with a resolved credential', () => {
    it('passes the credential as the third argument', async () => {
      const execute = vi.fn(async () => 'ok');
      const tool = new AuthenticatedFunctionTool({
        name: 'api_key_tool',
        description: 'Needs an API key.',
        authConfig: createApiKeyAuthConfig(),
        execute,
      });
      const toolContext = createToolContext();

      expect(await tool.runAsync({args: {}, toolContext})).toBe('ok');
      expect(execute).toHaveBeenCalledWith({}, toolContext, API_KEY_CREDENTIAL);
    });

    it('declares only the schema parameters, never the credential', () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'declared_tool',
        description: 'Has a schema.',
        parameters: z.object({visibility: z.string()}),
        authConfig: createApiKeyAuthConfig(),
        execute: async () => 'ok',
      });

      expect(
        Object.keys(tool._getDeclaration().parameters?.properties ?? {}),
      ).toEqual(['visibility']);
    });

    it('rejects invalid arguments before requesting a credential', async () => {
      const toolContext = createToolContext(new EmptyCredentialService());
      const requestCredential = vi.spyOn(toolContext, 'requestCredential');
      const execute = vi.fn();
      const tool = new AuthenticatedFunctionTool({
        name: 'validated_tool',
        description: 'Has a schema.',
        parameters: z.object({count: z.number()}),
        authConfig: createOAuth2AuthConfig(),
        execute,
      });

      await expect(
        tool.runAsync({args: {count: 'not-a-number'}, toolContext}),
      ).rejects.toThrow("Error in tool 'validated_tool'");
      expect(requestCredential).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it('pauses for confirmation before requesting a credential', async () => {
      const toolContext = createToolContext(new EmptyCredentialService());
      const requestCredential = vi.spyOn(toolContext, 'requestCredential');
      const execute = vi.fn();
      const tool = new AuthenticatedFunctionTool({
        name: 'gated_tool',
        description: 'Needs approval.',
        requireConfirmation: true,
        authConfig: createOAuth2AuthConfig(),
        execute,
      });

      expect(await tool.runAsync({args: {}, toolContext})).toEqual({
        error:
          'This tool call requires confirmation, please approve or reject.',
      });
      expect(requestCredential).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it('gives each concurrent call its own credential', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'concurrent_tool',
        description: 'Runs concurrently.',
        authConfig: createOAuth2AuthConfig(),
        execute: async (_input, _toolContext, credential) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return credential?.oauth2?.accessToken;
        },
      });

      const [first, second] = await Promise.all([
        tool.runAsync({
          args: {},
          toolContext: createToolContext(
            new StaticCredentialService('token-a'),
          ),
        }),
        tool.runAsync({
          args: {},
          toolContext: createToolContext(
            new StaticCredentialService('token-b'),
          ),
        }),
      ]);

      expect([first, second]).toEqual(['token-a', 'token-b']);
    });
  });

  describe('without a credential', () => {
    it('asks the client and returns the default pending response', async () => {
      const toolContext = createToolContext(new EmptyCredentialService());
      const requestCredential = vi.spyOn(toolContext, 'requestCredential');
      const execute = vi.fn();
      const authConfig = createOAuth2AuthConfig();
      const tool = new AuthenticatedFunctionTool({
        name: 'pending_tool',
        description: 'Needs consent.',
        authConfig,
        execute,
      });

      expect(await tool.runAsync({args: {}, toolContext})).toBe(
        PENDING_USER_AUTHORIZATION,
      );
      expect(requestCredential).toHaveBeenCalledWith(authConfig);
      expect(execute).not.toHaveBeenCalled();
    });

    it('returns a custom responseForAuthRequired', async () => {
      const responseForAuthRequired = {status: 'auth_required'};
      const tool = new AuthenticatedFunctionTool({
        name: 'custom_pending_tool',
        description: 'Needs consent.',
        authConfig: createOAuth2AuthConfig(),
        responseForAuthRequired,
        execute: async () => 'never',
      });

      expect(
        await tool.runAsync({
          args: {},
          toolContext: createToolContext(new EmptyCredentialService()),
        }),
      ).toEqual(responseForAuthRequired);
    });
  });

  describe('errors', () => {
    it('wraps an error thrown by the function', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'failing_tool',
        description: 'Fails.',
        authConfig: createApiKeyAuthConfig(),
        execute: async () => {
          throw new Error('body failed');
        },
      });

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow("Error in tool 'failing_tool': body failed");
    });

    it('wraps an error raised while resolving the credential', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'invalid_config_tool',
        description: 'Has an invalid auth config.',
        authConfig: {
          authScheme: {type: 'oauth2', flows: {}} as AuthScheme,
          credentialKey: 'oauth-key',
        },
        execute: async () => 'never',
      });

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow(
        "Error in tool 'invalid_config_tool': rawAuthCredential is required for auth scheme type oauth2",
      );
    });

    it('rejects a call that carries no tool context', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'contextless_tool',
        description: 'Needs a context.',
        authConfig: createApiKeyAuthConfig(),
        execute: async () => 'never',
      });

      // A JavaScript caller is not bound by the non-optional `toolContext`.
      await expect(
        tool.runAsync({args: {}} as RunAsyncToolRequest),
      ).rejects.toThrow(
        "Error in tool 'contextless_tool': AuthenticatedFunctionTool requires a tool context to authenticate.",
      );
    });
  });

  describe('end to end', () => {
    it('runs with a credential the real credential service holds', async () => {
      const credentialService = new InMemoryCredentialService();
      const authConfig = createApiKeyAuthConfig();
      const tool = new AuthenticatedFunctionTool({
        name: 'read_inbox',
        description: 'Reads the inbox.',
        parameters: z.object({folder: z.string()}),
        authConfig,
        execute: async ({folder}, _toolContext, credential) =>
          `${folder}:${credential?.apiKey}`,
      });

      const result = await tool.runAsync({
        args: {folder: 'reports'},
        toolContext: createToolContext(credentialService),
      });

      expect(result).toBe('reports:configured-api-key');
    });

    it('pauses an OAuth2 tool and parks the auth request', async () => {
      const credentialService = new InMemoryCredentialService();
      const toolContext = createToolContext(credentialService, 'call-42');
      const execute = vi.fn();
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists documents.',
        authConfig: createOAuth2AuthConfig(),
        execute,
      });

      const result = await tool.runAsync({args: {}, toolContext});

      expect(result).toBe(PENDING_USER_AUTHORIZATION);
      expect(execute).not.toHaveBeenCalled();
      const requested =
        toolContext.eventActions.requestedAuthConfigs['call-42'];
      expect(requested?.exchangedAuthCredential?.oauth2?.authUri).toContain(
        'https://provider.example.com/authorize',
      );
    });

    it('reuses a credential a previous call stored in the service', async () => {
      const credentialService = new InMemoryCredentialService();
      const authConfig = createOAuth2AuthConfig();
      const tool = new AuthenticatedFunctionTool({
        name: 'fetch_profile',
        description: 'Fetches the profile.',
        authConfig,
        execute: async (_input, _toolContext, credential) =>
          credential?.oauth2?.accessToken,
      });
      const toolContext = createToolContext(credentialService);
      vi.spyOn(toolContext, 'getAuthResponse').mockReturnValue({
        authType: AuthCredentialTypes.OAUTH2,
        oauth2: {accessToken: 'granted-token'},
      });

      const first = await tool.runAsync({args: {}, toolContext});

      const secondContext = createToolContext(credentialService);
      const requestCredential = vi.spyOn(secondContext, 'requestCredential');
      const second = await tool.runAsync({
        args: {},
        toolContext: secondContext,
      });

      expect(first).toBe('granted-token');
      expect(second).toBe('granted-token');
      expect(requestCredential).not.toHaveBeenCalled();
    });
  });
});
