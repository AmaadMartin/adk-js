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
  CredentialManager,
  InvocationContext,
  PENDING_USER_AUTHORIZATION,
  PluginManager,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v4';

import {withCredential} from '../../src/tools/authenticated_function_tool.js';

const CREDENTIAL_KEY = 'documents_api';

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'raw-api-key',
};

const API_KEY_AUTH_CONFIG: AuthConfig = {
  authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
  rawAuthCredential: API_KEY_CREDENTIAL,
  credentialKey: CREDENTIAL_KEY,
};

const AUTHORIZATION_CODE_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://provider.example.com/authorize',
      tokenUrl: 'https://provider.example.com/token',
      scopes: {'documents.read': 'Read your documents'},
    },
  },
};

const CONSENT_REQUIRED_AUTH_CONFIG: AuthConfig = {
  authScheme: AUTHORIZATION_CODE_SCHEME,
  rawAuthCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
  },
  credentialKey: CREDENTIAL_KEY,
};

const FOLDER_PARAMETERS = z.object({folder: z.string()});

function createToolContext(options?: {
  credentialService?: BaseCredentialService;
  userId?: string;
  functionCallId?: string;
}): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({
      id: 'session-1',
      appName: 'test_app',
      userId: options?.userId ?? 'user_1',
    }),
    pluginManager: new PluginManager([]),
    credentialService: options?.credentialService,
  });
  return new Context({
    invocationContext,
    functionCallId: options?.functionCallId ?? 'call_1',
  });
}

/**
 * Serves a different credential per user. When gated, it holds every load
 * until {@link release}, so two tool calls can be made to overlap.
 */
class PerUserCredentialService implements BaseCredentialService {
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly credentialsByUser: Record<string, AuthCredential>,
    private readonly gated = false,
  ) {}

  async loadCredential(
    authConfig: AuthConfig,
    toolContext: Context,
  ): Promise<AuthCredential | undefined> {
    if (this.gated) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    return this.credentialsByUser[toolContext.invocationContext.session.userId];
  }

  async saveCredential(): Promise<void> {}

  get waitingCount(): number {
    return this.waiting.length;
  }

  /** Lets the load that has waited longest, or the most recent one, proceed. */
  release(which: 'first' | 'last'): void {
    const resolve =
      which === 'first' ? this.waiting.shift() : this.waiting.pop();
    resolve?.();
  }
}

describe('AuthenticatedFunctionTool', () => {
  describe('with a credential available', () => {
    it('passes the credential to the function as the third argument', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        parameters: FOLDER_PARAMETERS,
        authConfig: API_KEY_AUTH_CONFIG,
        execute: ({folder}, _toolContext, credential) => ({
          folder,
          apiKey: credential.apiKey,
        }),
      });

      const result = await tool.runAsync({
        args: {folder: 'reports'},
        toolContext: createToolContext(),
      });

      expect(result).toEqual({folder: 'reports', apiKey: 'raw-api-key'});
    });

    it('runs a function that ignores the credential argument', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        parameters: FOLDER_PARAMETERS,
        authConfig: API_KEY_AUTH_CONFIG,
        execute: ({folder}) => `${folder}/report.pdf`,
      });

      const result = await tool.runAsync({
        args: {folder: 'reports'},
        toolContext: createToolContext(),
      });

      expect(result).toBe('reports/report.pdf');
    });

    it('surfaces an error the function throws', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        authConfig: API_KEY_AUTH_CONFIG,
        execute: () => {
          throw new Error('the provider is down');
        },
      });

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow("Error in tool 'list_documents': the provider is down");
    });
  });

  describe('when the client must supply a credential', () => {
    it('returns the default placeholder and does not run the function', async () => {
      let executed = false;
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
        execute: () => {
          executed = true;
          return 'ok';
        },
      });
      const toolContext = createToolContext();

      const result = await tool.runAsync({args: {}, toolContext});

      expect(result).toBe(PENDING_USER_AUTHORIZATION);
      expect(result).toBe('Pending User Authorization.');
      expect(executed).toBe(false);
    });

    it('asks the client for a credential exactly once', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
        execute: () => 'ok',
      });
      const toolContext = createToolContext({functionCallId: 'call_7'});

      await tool.runAsync({args: {}, toolContext});

      const requested = toolContext.eventActions.requestedAuthConfigs;
      expect(Object.keys(requested)).toEqual(['call_7']);
      expect(requested['call_7'].credentialKey).toBe(CREDENTIAL_KEY);
      expect(
        requested['call_7'].exchangedAuthCredential?.oauth2?.authUri,
      ).toContain('https://provider.example.com/authorize');
    });

    it('returns a custom string response', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
        responseForAuthRequired: 'Sign in to read your documents.',
        execute: () => 'ok',
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: createToolContext(),
      });

      expect(result).toBe('Sign in to read your documents.');
    });

    it('returns a custom object response without stringifying it', async () => {
      const responseForAuthRequired = {pending: true, message: 'Sign in.'};
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
        responseForAuthRequired,
        execute: () => 'ok',
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: createToolContext(),
      });

      expect(result).toEqual(responseForAuthRequired);
    });
  });

  describe('error paths', () => {
    it('surfaces a credential resolution failure and does not run the function', async () => {
      let executed = false;
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        authConfig: {
          authScheme: AUTHORIZATION_CODE_SCHEME,
          credentialKey: CREDENTIAL_KEY,
        },
        execute: () => {
          executed = true;
          return 'ok';
        },
      });

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow(
        "Error in tool 'list_documents': rawAuthCredential is required for authScheme type oauth2.",
      );
      expect(executed).toBe(false);
    });

    it('rejects a call that arrives with no tool context', async () => {
      const wrapped = withCredential(
        'list_documents',
        new CredentialManager(API_KEY_AUTH_CONFIG),
        () => 'ok',
      );

      await expect(wrapped('', undefined)).rejects.toThrow(
        "Tool 'list_documents' requires authentication but no tool context was provided.",
      );
    });
  });

  describe('ordering', () => {
    it('validates the arguments before it resolves a credential', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        parameters: FOLDER_PARAMETERS,
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
        execute: () => 'ok',
      });
      const toolContext = createToolContext();

      await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
        /Error in tool 'list_documents'/,
      );
      expect(toolContext.eventActions.requestedAuthConfigs).toEqual({});
    });

    it('applies the confirmation gate before it resolves a credential', async () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
        requireConfirmation: true,
        execute: () => 'ok',
      });
      const toolContext = createToolContext();

      const result = await tool.runAsync({args: {}, toolContext});

      expect(result).toEqual({
        error:
          'This tool call requires confirmation, please approve or reject.',
      });
      expect(toolContext.eventActions.requestedAuthConfigs).toEqual({});
    });
  });

  describe('declaration', () => {
    it('exposes only the declared parameters, never the credential', () => {
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        parameters: FOLDER_PARAMETERS,
        authConfig: API_KEY_AUTH_CONFIG,
        execute: () => 'ok',
      });

      const declaration = tool._getDeclaration();

      expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
        'folder',
      ]);
    });

    it('names the tool after the function when no name is given', () => {
      async function listDocuments() {
        return 'ok';
      }

      const tool = new AuthenticatedFunctionTool({
        description: 'Lists the documents in a folder.',
        authConfig: API_KEY_AUTH_CONFIG,
        execute: listDocuments,
      });

      expect(tool.name).toBe('listDocuments');
    });
  });

  describe('calls do not share state', () => {
    it('resolves a credential per call, not once per tool', async () => {
      const credentialService = new PerUserCredentialService({
        user_1: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {accessToken: 'token-for-user-1'},
        },
        user_2: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {accessToken: 'token-for-user-2'},
        },
      });
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
        execute: (_input, _toolContext, credential) =>
          credential.oauth2?.accessToken,
      });

      const first = await tool.runAsync({
        args: {},
        toolContext: createToolContext({credentialService, userId: 'user_1'}),
      });
      const second = await tool.runAsync({
        args: {},
        toolContext: createToolContext({credentialService, userId: 'user_2'}),
      });

      expect(first).toBe('token-for-user-1');
      expect(second).toBe('token-for-user-2');
    });

    it('gives each overlapping call its own credential', async () => {
      const credentialService = new PerUserCredentialService(
        {
          user_1: {
            authType: AuthCredentialTypes.OAUTH2,
            oauth2: {accessToken: 'token-for-user-1'},
          },
          user_2: {
            authType: AuthCredentialTypes.OAUTH2,
            oauth2: {accessToken: 'token-for-user-2'},
          },
        },
        true,
      );
      const tool = new AuthenticatedFunctionTool({
        name: 'list_documents',
        description: 'Lists the documents in a folder.',
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
        execute: (_input, toolContext, credential) =>
          `${toolContext.invocationContext.session.userId}:${credential.oauth2?.accessToken}`,
      });

      const first = tool.runAsync({
        args: {},
        toolContext: createToolContext({credentialService, userId: 'user_1'}),
      });
      const second = tool.runAsync({
        args: {},
        toolContext: createToolContext({credentialService, userId: 'user_2'}),
      });
      await vi.waitFor(() => expect(credentialService.waitingCount).toBe(2));

      // Finish the second call first: a credential parked on the instance
      // would leak into the first call's result.
      credentialService.release('last');
      credentialService.release('first');

      expect(await first).toBe('user_1:token-for-user-1');
      expect(await second).toBe('user_2:token-for-user-2');
    });
  });
});
