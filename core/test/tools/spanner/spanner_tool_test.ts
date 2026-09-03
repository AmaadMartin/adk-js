/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SPANNER_TOKEN_CACHE_KEY,
  SpannerCredentialsConfig,
  SpannerTool,
  SpannerToolCall,
  SpannerToolSettings,
  SpannerToolStatus,
} from '@google/adk';
import {Type} from '@google/genai';
import {AuthClient} from 'google-auth-library';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {createToolContext} from './spanner_test_utils.js';

const parameters = z.object({
  project_id: z.string().describe('The Google Cloud project id.'),
});

interface RecordedCall {
  args: {project_id: string};
  credentials?: AuthClient;
  settings: SpannerToolSettings;
}

function createTool(options: {
  credentialsConfig?: SpannerCredentialsConfig;
  toolSettings?: SpannerToolSettings;
  execute?: (call: SpannerToolCall<{project_id: string}>) => Promise<never>;
}): {tool: SpannerTool; calls: RecordedCall[]} {
  const calls: RecordedCall[] = [];
  const tool = SpannerTool.create({
    name: 'probe',
    description: 'Records the call it received.',
    parameters,
    credentialsConfig: options.credentialsConfig,
    toolSettings: options.toolSettings ?? new SpannerToolSettings(),
    execute: async (call) => {
      calls.push(call);
      if (options.execute) {
        return options.execute(call);
      }
      return {status: SpannerToolStatus.SUCCESS, results: call.args.project_id};
    },
  });
  return {tool, calls};
}

describe('SpannerTool', () => {
  it('declares only the model-facing parameters', () => {
    const {tool} = createTool({});
    expect(tool._getDeclaration()).toEqual({
      name: 'probe',
      description: 'Records the call it received.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          project_id: {
            type: Type.STRING,
            description: 'The Google Cloud project id.',
          },
        },
        required: ['project_id'],
      },
    });
  });

  it('prefixes the declared name and keeps the base name for filtering', () => {
    const tool = SpannerTool.create({
      name: 'probe',
      description: 'A probe.',
      parameters,
      prefix: 'spanner',
      toolSettings: new SpannerToolSettings(),
      execute: async () => ({
        status: SpannerToolStatus.SUCCESS,
        results: null,
      }),
    });
    expect(tool.name).toBe('spanner_probe');
    expect(tool.baseName).toBe('probe');
  });

  it('injects the settings and leaves the credentials absent when unconfigured', async () => {
    const toolSettings = new SpannerToolSettings({databaseRole: 'reader'});
    const {tool, calls} = createTool({toolSettings});

    const result = await tool.runAsync({
      args: {project_id: 'my-project'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      status: SpannerToolStatus.SUCCESS,
      results: 'my-project',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.settings).toBe(toolSettings);
    expect(calls[0]?.credentials).toBeUndefined();
    expect(calls[0]?.args).toEqual({project_id: 'my-project'});
  });

  it('injects the resolved credentials', async () => {
    const {tool, calls} = createTool({
      credentialsConfig: new SpannerCredentialsConfig({
        externalAccessTokenKey: 'my_token',
      }),
    });

    await tool.runAsync({
      args: {project_id: 'my-project'},
      toolContext: createToolContext({state: {my_token: 'external-token'}}),
    });

    expect(calls[0]?.credentials?.credentials.access_token).toBe(
      'external-token',
    );
  });

  it('asks for authorization while the OAuth flow is pending', async () => {
    const {tool, calls} = createTool({
      credentialsConfig: new SpannerCredentialsConfig({
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }),
    });
    const toolContext = createToolContext({functionCallId: 'call-1'});

    const result = await tool.runAsync({
      args: {project_id: 'my-project'},
      toolContext,
    });

    expect(result).toBe(
      'User authorization is required to access Google services for probe.' +
        ' Please complete the authorization flow.',
    );
    expect(calls).toEqual([]);
    expect(
      toolContext.eventActions.requestedAuthConfigs['call-1'],
    ).toBeDefined();
  });

  it('runs once the OAuth flow has completed', async () => {
    const {tool, calls} = createTool({
      credentialsConfig: new SpannerCredentialsConfig({
        clientId: 'client-id',
        clientSecret: 'client-secret',
      }),
    });

    await tool.runAsync({
      args: {project_id: 'my-project'},
      toolContext: createToolContext({
        state: {[SPANNER_TOKEN_CACHE_KEY]: {accessToken: 'cached-token'}},
        functionCallId: 'call-1',
      }),
    });

    expect(calls[0]?.credentials?.credentials.access_token).toBe(
      'cached-token',
    );
  });

  it('turns a thrown error into an error result', async () => {
    const {tool} = createTool({
      execute: async () => {
        throw new Error('Table not found: hotels');
      },
    });

    await expect(
      tool.runAsync({
        args: {project_id: 'my-project'},
        toolContext: createToolContext(),
      }),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'Table not found: hotels',
    });
  });

  it('turns a thrown non-error into an error result', async () => {
    const {tool} = createTool({
      execute: async () => {
        throw 'plain rejection';
      },
    });

    await expect(
      tool.runAsync({
        args: {project_id: 'my-project'},
        toolContext: createToolContext(),
      }),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details: 'plain rejection',
    });
  });

  it('turns a credential failure into an error result', async () => {
    const {tool} = createTool({
      credentialsConfig: new SpannerCredentialsConfig({
        externalAccessTokenKey: 'my_token',
      }),
    });

    await expect(
      tool.runAsync({
        args: {project_id: 'my-project'},
        toolContext: createToolContext(),
      }),
    ).resolves.toEqual({
      status: SpannerToolStatus.ERROR,
      error_details:
        'external_access_token_key is provided but no access token found in' +
        ' tool_context.state with key my_token.',
    });
  });

  it('turns an argument the schema rejects into an error result', async () => {
    const {tool, calls} = createTool({});

    const result = await tool.runAsync({
      args: {project_id: 42},
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({status: SpannerToolStatus.ERROR});
    expect(calls).toEqual([]);
  });
});
