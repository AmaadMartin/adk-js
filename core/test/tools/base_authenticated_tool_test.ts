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
  BaseAuthenticatedTool,
  BaseAuthenticatedToolParams,
  BaseCredentialService,
  Context,
  InMemoryCredentialService,
  InvocationContext,
  PENDING_USER_AUTHORIZATION,
  PluginManager,
  RunAsyncAuthenticatedToolRequest,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const CREDENTIAL_KEY = 'documents_api';
const APP_NAME = 'test_app';
const USER_ID = 'user_1';

const API_KEY_AUTH_CONFIG: AuthConfig = {
  authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
  rawAuthCredential: {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: 'raw-api-key',
  },
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

/** An OAuth2 credential that needs no exchange and no refresh. */
const STORED_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.OAUTH2,
  oauth2: {clientId: 'client-id', accessToken: 'stored-access-token'},
};

function createToolContext(options?: {
  credentialService?: BaseCredentialService;
  functionCallId?: string;
}): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({
      id: 'session-1',
      appName: APP_NAME,
      userId: USER_ID,
    }),
    pluginManager: new PluginManager([]),
    credentialService: options?.credentialService,
  });
  return new Context({
    invocationContext,
    functionCallId: options?.functionCallId ?? 'call_1',
  });
}

/** A credential service already holding {@link STORED_CREDENTIAL}. */
async function createSeededCredentialService(): Promise<BaseCredentialService> {
  const credentialService = new InMemoryCredentialService();
  await credentialService.saveCredential(
    {
      ...CONSENT_REQUIRED_AUTH_CONFIG,
      exchangedAuthCredential: STORED_CREDENTIAL,
    },
    createToolContext(),
  );
  return credentialService;
}

/** A credential service whose every read fails. */
class FailingCredentialService implements BaseCredentialService {
  async loadCredential(): Promise<AuthCredential | undefined> {
    throw new Error('the credential store is unreachable');
  }

  async saveCredential(): Promise<void> {}
}

type ToolBody = (request: RunAsyncAuthenticatedToolRequest) => Promise<unknown>;

/** Records every call its body receives, so a test can assert it never ran. */
class RecordingTool extends BaseAuthenticatedTool {
  readonly calls: RunAsyncAuthenticatedToolRequest[] = [];
  private readonly body: ToolBody;

  constructor({
    body,
    ...params
  }: Partial<BaseAuthenticatedToolParams> & {body?: ToolBody}) {
    super({
      name: params.name ?? 'list_documents',
      description: params.description ?? 'Lists the documents in a folder.',
      ...params,
    });
    this.body = body ?? (async () => 'ok');
  }

  protected override async runAsyncImpl(
    request: RunAsyncAuthenticatedToolRequest,
  ): Promise<unknown> {
    this.calls.push(request);
    return this.body(request);
  }
}

describe('BaseAuthenticatedTool', () => {
  describe('without an auth config', () => {
    it('runs the body with no credential and never asks the client', async () => {
      const tool = new RecordingTool({});
      const toolContext = createToolContext();

      const result = await tool.runAsync({
        args: {folder: 'reports'},
        toolContext,
      });

      expect(result).toBe('ok');
      expect(tool.calls).toHaveLength(1);
      expect(tool.calls[0].credential).toBeUndefined();
      expect(tool.calls[0].toolContext).toBe(toolContext);
      expect(toolContext.eventActions.requestedAuthConfigs).toEqual({});
    });
  });

  describe('with a credential available', () => {
    it('keeps the name and the description it was constructed with', () => {
      const tool = new RecordingTool({
        name: 'read_calendar',
        description: 'Reads the calendar.',
        authConfig: API_KEY_AUTH_CONFIG,
      });

      expect(tool.name).toBe('read_calendar');
      expect(tool.description).toBe('Reads the calendar.');
    });

    it('passes an immediately usable raw credential to the body', async () => {
      const tool = new RecordingTool({authConfig: API_KEY_AUTH_CONFIG});

      const result = await tool.runAsync({
        args: {folder: 'reports'},
        toolContext: createToolContext(),
      });

      expect(result).toBe('ok');
      expect(tool.calls[0].credential).toEqual({
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'raw-api-key',
      });
    });

    it('passes a credential the credential service holds', async () => {
      const tool = new RecordingTool({
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
      });
      const toolContext = createToolContext({
        credentialService: await createSeededCredentialService(),
      });

      await tool.runAsync({args: {}, toolContext});

      expect(tool.calls[0].credential).toEqual(STORED_CREDENTIAL);
      expect(toolContext.eventActions.requestedAuthConfigs).toEqual({});
    });

    it('passes the arguments through to the body unchanged', async () => {
      const tool = new RecordingTool({authConfig: API_KEY_AUTH_CONFIG});
      const args = {
        folder: 'reports',
        depth: 3,
        filters: ['pdf', 'docx'],
        options: {recursive: true, since: null},
      };

      await tool.runAsync({args: {}, toolContext: createToolContext()});
      await tool.runAsync({args, toolContext: createToolContext()});

      expect(tool.calls[0].args).toEqual({});
      expect(tool.calls[1].args).toBe(args);
      expect(tool.calls[1].args).toEqual(args);
    });

    it('returns undefined, an object and an array unchanged', async () => {
      const returnValues: unknown[] = [undefined, {files: 2}, ['a', 'b']];
      const results: unknown[] = [];
      for (const returnValue of returnValues) {
        const tool = new RecordingTool({
          authConfig: API_KEY_AUTH_CONFIG,
          body: async () => returnValue,
        });
        results.push(
          await tool.runAsync({args: {}, toolContext: createToolContext()}),
        );
      }

      expect(results).toEqual(returnValues);
    });
  });

  describe('when the client must supply a credential', () => {
    it('returns the default placeholder and does not run the body', async () => {
      const tool = new RecordingTool({
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: createToolContext(),
      });

      expect(result).toBe(PENDING_USER_AUTHORIZATION);
      expect(result).toBe('Pending User Authorization.');
      expect(tool.calls).toHaveLength(0);
    });

    it('records the auth request on the tool context', async () => {
      const tool = new RecordingTool({
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
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
      const tool = new RecordingTool({
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
        responseForAuthRequired: 'Sign in to read your documents.',
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: createToolContext(),
      });

      expect(result).toBe('Sign in to read your documents.');
      expect(tool.calls).toHaveLength(0);
    });

    it('returns a custom object response unchanged', async () => {
      const responseForAuthRequired = {status: 'auth_required', retry: true};
      const tool = new RecordingTool({
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
        responseForAuthRequired,
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: createToolContext(),
      });

      expect(result).toBe(responseForAuthRequired);
    });

    it('returns an empty response when that is what the tool configured', async () => {
      const emptyString = new RecordingTool({
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
        responseForAuthRequired: '',
      });
      const emptyObject = new RecordingTool({
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
        responseForAuthRequired: {},
      });

      expect(
        await emptyString.runAsync({
          args: {},
          toolContext: createToolContext(),
        }),
      ).toBe('');
      expect(
        await emptyObject.runAsync({
          args: {},
          toolContext: createToolContext(),
        }),
      ).toEqual({});
    });
  });

  describe('when resolution fails', () => {
    it('propagates an error the body throws', async () => {
      const tool = new RecordingTool({
        authConfig: API_KEY_AUTH_CONFIG,
        body: async () => {
          throw new Error('Implementation failed');
        },
      });

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow('Implementation failed');
    });

    it('propagates a credential service failure and does not run the body', async () => {
      const tool = new RecordingTool({
        authConfig: CONSENT_REQUIRED_AUTH_CONFIG,
      });
      const toolContext = createToolContext({
        credentialService: new FailingCredentialService(),
      });

      await expect(tool.runAsync({args: {}, toolContext})).rejects.toThrow(
        'the credential store is unreachable',
      );
      expect(tool.calls).toHaveLength(0);
      expect(toolContext.eventActions.requestedAuthConfigs).toEqual({});
    });

    it('propagates an invalid auth config and does not run the body', async () => {
      const tool = new RecordingTool({
        authConfig: {
          authScheme: AUTHORIZATION_CODE_SCHEME,
          credentialKey: CREDENTIAL_KEY,
        },
      });

      await expect(
        tool.runAsync({args: {}, toolContext: createToolContext()}),
      ).rejects.toThrow('rawAuthCredential is required for authScheme type');
      expect(tool.calls).toHaveLength(0);
    });
  });
});
