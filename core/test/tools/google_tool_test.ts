/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  BaseGoogleCredentialsConfig,
  Context,
  GoogleCredentialsManager,
  GoogleTool,
  GoogleToolExecuteContext,
  State,
} from '@google/adk';
import {Type} from '@google/genai';
import {OAuth2Client} from 'google-auth-library';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const SCOPES = ['https://www.googleapis.com/auth/bigquery'];
const HOUR_MS = 60 * 60 * 1000;

interface TestSettings {
  maxRows: number;
}

const TOOL_SETTINGS: TestSettings = {maxRows: 50};

function createToolContext() {
  const getAuthResponse =
    vi.fn<(authConfig: AuthConfig) => AuthCredential | undefined>();
  const requestCredential = vi.fn<(authConfig: AuthConfig) => void>();
  const context = {
    state: new State(),
    getAuthResponse,
    requestCredential,
  } as unknown as Context;

  return {context, getAuthResponse, requestCredential};
}

function oauthConfig(): BaseGoogleCredentialsConfig {
  return new BaseGoogleCredentialsConfig({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: SCOPES,
  });
}

/** Makes the credentials manager resolve to a ready-to-use client. */
function stubResolvedCredentials(client: OAuth2Client) {
  return vi
    .spyOn(GoogleCredentialsManager.prototype, 'getValidCredentials')
    .mockResolvedValue(client);
}

/** Makes the credentials manager report an OAuth flow still in flight. */
function stubPendingAuthorization() {
  return vi
    .spyOn(GoogleCredentialsManager.prototype, 'getValidCredentials')
    .mockResolvedValue(undefined);
}

function authorizedClient(): OAuth2Client {
  const client = new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  client.setCredentials({
    access_token: 'valid-token',
    expiry_date: Date.now() + HOUR_MS,
  });
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GoogleTool', () => {
  describe('construction', () => {
    it('takes its name and description from the options', () => {
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        credentialsConfig: oauthConfig(),
        execute: () => 'ok',
      });

      expect(tool.name).toBe('list_datasets');
      expect(tool.description).toBe('Lists BigQuery datasets.');
    });

    it('falls back to the name of the wrapped function', () => {
      async function listDatasets() {
        return 'ok';
      }

      const tool = new GoogleTool({
        description: 'Lists BigQuery datasets.',
        execute: listDatasets,
      });

      expect(tool.name).toBe('listDatasets');
    });

    it('forwards isLongRunning to the base tool', () => {
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        isLongRunning: true,
        execute: () => 'ok',
      });

      expect(tool.isLongRunning).toBe(true);
    });
  });

  describe('_getDeclaration', () => {
    it('exposes only the declared zod schema', () => {
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        parameters: z.object({projectId: z.string()}),
        credentialsConfig: oauthConfig(),
        toolSettings: TOOL_SETTINGS,
        execute: () => 'ok',
      });

      expect(tool._getDeclaration().parameters).toEqual({
        type: Type.OBJECT,
        properties: {projectId: {type: Type.STRING}},
        required: ['projectId'],
      });
    });

    it('exposes only the declared genai schema', () => {
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        parameters: {
          type: Type.OBJECT,
          properties: {projectId: {type: Type.STRING}},
          required: ['projectId'],
        },
        credentialsConfig: oauthConfig(),
        toolSettings: TOOL_SETTINGS,
        execute: () => 'ok',
      });

      const {properties, required} = tool._getDeclaration().parameters ?? {};
      expect(Object.keys(properties ?? {})).toEqual(['projectId']);
      expect(required).toEqual(['projectId']);
    });
  });

  describe('runAsync', () => {
    it('hands the resolved credential and the settings to the function', async () => {
      const client = authorizedClient();
      stubResolvedCredentials(client);
      const execute = vi.fn(
        (
          _input: string,
          _toolContext?: Context,
          _google?: GoogleToolExecuteContext<TestSettings>,
        ) => ({result: 'Success'}),
      );
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        credentialsConfig: oauthConfig(),
        toolSettings: TOOL_SETTINGS,
        execute,
      });
      const {context} = createToolContext();

      const result = await tool.runAsync({args: {}, toolContext: context});

      expect(result).toEqual({result: 'Success'});
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][2]).toEqual({
        credentials: client,
        settings: TOOL_SETTINGS,
      });
    });

    it('awaits an async wrapped function', async () => {
      stubResolvedCredentials(authorizedClient());
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        credentialsConfig: oauthConfig(),
        execute: async () => ({result: 'Async success'}),
      });
      const {context} = createToolContext();

      const result = await tool.runAsync({args: {}, toolContext: context});

      expect(result).toEqual({result: 'Async success'});
    });

    it('passes zod-validated arguments through unchanged', async () => {
      stubResolvedCredentials(authorizedClient());
      const execute = vi.fn(({projectId}: {projectId: string}) => projectId);
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        parameters: z.object({projectId: z.string()}),
        credentialsConfig: oauthConfig(),
        execute,
      });
      const {context} = createToolContext();

      const result = await tool.runAsync({
        args: {projectId: 'my-project'},
        toolContext: context,
      });

      expect(result).toBe('my-project');
      expect(execute.mock.calls[0][0]).toEqual({projectId: 'my-project'});
    });

    it('does not call the function while an OAuth flow is in flight', async () => {
      stubPendingAuthorization();
      const execute = vi.fn(() => 'never');
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        credentialsConfig: oauthConfig(),
        execute,
      });
      const {context} = createToolContext();

      const result = await tool.runAsync({args: {}, toolContext: context});

      expect(execute).not.toHaveBeenCalled();
      expect(result).toBe(
        'User authorization is required to access Google services for list_datasets. Please complete the authorization flow.',
      );
    });

    it('requests a credential through the real manager on the first turn', async () => {
      const execute = vi.fn(() => 'never');
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        credentialsConfig: oauthConfig(),
        execute,
      });
      const {context, getAuthResponse, requestCredential} = createToolContext();
      getAuthResponse.mockReturnValue(undefined);

      const result = await tool.runAsync({args: {}, toolContext: context});

      expect(execute).not.toHaveBeenCalled();
      expect(requestCredential).toHaveBeenCalledTimes(1);
      expect(String(result)).toContain('authorization is required');
      expect(String(result)).toContain('list_datasets');
    });

    it('runs without credential machinery when no config is given', async () => {
      const execute = vi.fn(
        (
          _input: string,
          _toolContext?: Context,
          _google?: GoogleToolExecuteContext<TestSettings>,
        ) => 'ok',
      );
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        toolSettings: TOOL_SETTINGS,
        execute,
      });
      const {context, getAuthResponse, requestCredential} = createToolContext();

      const result = await tool.runAsync({args: {}, toolContext: context});

      expect(result).toBe('ok');
      expect(execute.mock.calls[0][2]).toEqual({
        credentials: undefined,
        settings: TOOL_SETTINGS,
      });
      expect(getAuthResponse).not.toHaveBeenCalled();
      expect(requestCredential).not.toHaveBeenCalled();
    });

    it('returns a structured error when the function throws', async () => {
      stubResolvedCredentials(authorizedClient());
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        credentialsConfig: oauthConfig(),
        execute: () => {
          throw new Error('Something went wrong');
        },
      });
      const {context} = createToolContext();

      const result = await tool.runAsync({args: {}, toolContext: context});

      expect(result).toMatchObject({status: 'ERROR'});
      expect(
        String((result as {error_details: string}).error_details),
      ).toContain('Something went wrong');
    });

    it('returns a structured error when the function throws a non-Error', async () => {
      stubResolvedCredentials(authorizedClient());
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        credentialsConfig: oauthConfig(),
        execute: () => {
          throw 'plain string failure';
        },
      });
      const {context} = createToolContext();

      const result = await tool.runAsync({args: {}, toolContext: context});

      expect(result).toMatchObject({status: 'ERROR'});
      expect(
        String((result as {error_details: string}).error_details),
      ).toContain('plain string failure');
    });

    it('returns a structured error when credential resolution throws', async () => {
      const execute = vi.fn(() => 'never');
      const tool = new GoogleTool({
        name: 'list_datasets',
        description: 'Lists BigQuery datasets.',
        credentialsConfig: new BaseGoogleCredentialsConfig({
          externalAccessTokenKey: 'missing_token',
        }),
        execute,
      });
      const {context} = createToolContext();

      const result = await tool.runAsync({args: {}, toolContext: context});

      expect(execute).not.toHaveBeenCalled();
      expect(result).toMatchObject({status: 'ERROR'});
      expect(
        String((result as {error_details: string}).error_details),
      ).toContain('no access token found');
    });
  });
});
