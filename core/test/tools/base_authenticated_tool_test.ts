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
  AuthenticatedRunRequest,
  BaseAuthenticatedTool,
  BaseAuthenticatedToolParams,
  BaseCredentialService,
  Context,
  InvocationContext,
  PENDING_USER_AUTHORIZATION,
  PluginManager,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

const API_KEY_SCHEME = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Api-Key',
} as const;

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'configured-api-key',
};

/** The options of the concrete test tool below. */
interface RecordingToolOptions extends Omit<
  BaseAuthenticatedToolParams,
  'name' | 'description'
> {
  /** What the tool body returns. */
  result?: unknown;
  /** The error the tool body throws instead of returning. */
  failWith?: Error;
}

/** A concrete tool that records what its body was called with. */
class RecordingAuthenticatedTool extends BaseAuthenticatedTool {
  readonly calls: AuthenticatedRunRequest[] = [];
  private readonly result?: unknown;
  private readonly failWith?: Error;

  constructor({result, failWith, ...params}: RecordingToolOptions = {}) {
    super({
      name: 'recording_tool',
      description: 'Records its calls.',
      ...params,
    });
    this.result = result;
    this.failWith = failWith;
  }

  protected override async runAsyncImpl(
    request: AuthenticatedRunRequest,
  ): Promise<unknown> {
    this.calls.push(request);
    if (this.failWith) {
      throw this.failWith;
    }
    return this.result;
  }
}

/** A credential service that never holds anything and records saves. */
class EmptyCredentialService implements BaseCredentialService {
  loadCalls = 0;

  async loadCredential(): Promise<AuthCredential | undefined> {
    this.loadCalls++;
    return undefined;
  }

  async saveCredential(): Promise<void> {}
}

function createToolContext(credentialService?: BaseCredentialService): Context {
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

  return new Context({invocationContext, functionCallId: 'call-1'});
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
    authScheme: {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://provider.example.com/authorize',
          tokenUrl: 'https://provider.example.com/token',
          scopes: {read: 'Read access'},
        },
      },
    } as AuthScheme,
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'client-id', clientSecret: 'client-secret'},
    },
    credentialKey: 'oauth-key',
  };
}

describe('BaseAuthenticatedTool', () => {
  describe('without authentication', () => {
    it('runs the body with no credential when authConfig is absent', async () => {
      const credentialService = new EmptyCredentialService();
      const toolContext = createToolContext(credentialService);
      const requestCredential = vi.spyOn(toolContext, 'requestCredential');
      const tool = new RecordingAuthenticatedTool({result: 'done'});

      expect(await tool.runAsync({args: {}, toolContext})).toBe('done');
      expect(tool.calls[0].credential).toBeUndefined();
      expect(credentialService.loadCalls).toBe(0);
      expect(requestCredential).not.toHaveBeenCalled();
    });

    it('runs the body with no credential when authScheme is falsy', async () => {
      const credentialService = new EmptyCredentialService();
      const toolContext = createToolContext(credentialService);
      // A JavaScript caller is not bound by the non-optional `authScheme`.
      const authConfig = {credentialKey: 'unused'} as AuthConfig;
      const tool = new RecordingAuthenticatedTool({authConfig, result: 'done'});

      expect(await tool.runAsync({args: {}, toolContext})).toBe('done');
      expect(tool.calls[0].credential).toBeUndefined();
      expect(credentialService.loadCalls).toBe(0);
    });
  });

  describe('with a resolved credential', () => {
    it('runs the body with the credential and does not ask the client', async () => {
      const toolContext = createToolContext();
      const requestCredential = vi.spyOn(toolContext, 'requestCredential');
      const tool = new RecordingAuthenticatedTool({
        authConfig: createApiKeyAuthConfig(),
        result: 'authorized',
      });

      expect(await tool.runAsync({args: {}, toolContext})).toBe('authorized');
      expect(tool.calls[0].credential).toEqual(API_KEY_CREDENTIAL);
      expect(requestCredential).not.toHaveBeenCalled();
    });

    it('passes the arguments through unmodified', async () => {
      const toolContext = createToolContext();
      const tool = new RecordingAuthenticatedTool({
        authConfig: createApiKeyAuthConfig(),
      });
      const args = {nested: {a: 1}, list: [1, 2, 3], flag: false};

      await tool.runAsync({args: {}, toolContext});
      await tool.runAsync({args, toolContext});

      expect(tool.calls[0].args).toEqual({});
      expect(tool.calls[1].args).toEqual(args);
    });

    it.each([
      ['an object', {value: 1}],
      ['a string', 'text'],
      ['a number', 42],
      ['null', null],
      ['undefined', undefined],
    ])('returns %s from the body unchanged', async (_label, result) => {
      const tool = new RecordingAuthenticatedTool({
        authConfig: createApiKeyAuthConfig(),
        result,
      });

      expect(
        await tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).toEqual(result);
    });
  });

  describe('without a credential', () => {
    it('asks the client and returns the default pending response', async () => {
      const toolContext = createToolContext(new EmptyCredentialService());
      const requestCredential = vi.spyOn(toolContext, 'requestCredential');
      const authConfig = createOAuth2AuthConfig();
      const tool = new RecordingAuthenticatedTool({authConfig});

      expect(await tool.runAsync({args: {}, toolContext})).toBe(
        PENDING_USER_AUTHORIZATION,
      );
      expect(requestCredential).toHaveBeenCalledWith(authConfig);
      expect(tool.calls).toEqual([]);
    });

    it('returns an object responseForAuthRequired', async () => {
      const responseForAuthRequired = {status: 'auth_required', code: 401};
      const tool = new RecordingAuthenticatedTool({
        authConfig: createOAuth2AuthConfig(),
        responseForAuthRequired,
      });

      expect(
        await tool.runAsync({
          args: {},
          toolContext: createToolContext(new EmptyCredentialService()),
        }),
      ).toEqual(responseForAuthRequired);
    });

    it('returns a string responseForAuthRequired', async () => {
      const tool = new RecordingAuthenticatedTool({
        authConfig: createOAuth2AuthConfig(),
        responseForAuthRequired: 'Please sign in.',
      });

      expect(
        await tool.runAsync({
          args: {},
          toolContext: createToolContext(new EmptyCredentialService()),
        }),
      ).toBe('Please sign in.');
    });

    it('records the auth request against the function call id', async () => {
      const toolContext = createToolContext(new EmptyCredentialService());
      const tool = new RecordingAuthenticatedTool({
        authConfig: createOAuth2AuthConfig(),
      });

      await tool.runAsync({args: {}, toolContext});

      expect(
        toolContext.eventActions.requestedAuthConfigs['call-1'],
      ).toBeDefined();
    });
  });

  describe('errors', () => {
    it('propagates an error from the body unwrapped', async () => {
      const failWith = new Error('body failed');
      const tool = new RecordingAuthenticatedTool({
        authConfig: createApiKeyAuthConfig(),
        failWith,
      });

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow(failWith);
    });

    it('propagates a credential manager error unwrapped', async () => {
      const tool = new RecordingAuthenticatedTool({
        authConfig: {
          authScheme: {
            type: 'oauth2',
            flows: {},
          } as AuthScheme,
          credentialKey: 'oauth-key',
        },
      });

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow(
        'rawAuthCredential is required for auth scheme type oauth2',
      );
      expect(tool.calls).toEqual([]);
    });
  });
});
