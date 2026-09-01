/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApplicationIntegrationToolset,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

vi.mock('google-auth-library', () => ({
  // ServiceAccountCredentialExchanger mints the tool's own token with a JWT.
  JWT: class {
    getAccessToken = async () => ({token: 'sa-token'});
    authorize = async () => ({access_token: 'sa-token'});
  },
  GoogleAuth: class {
    getAccessToken = async () => 'adc-token';
    getClient = async () => ({
      quotaProjectId: 'quota-project',
      getAccessToken: async () => ({token: 'adc-token'}),
    });
    getProjectId = async () => 'adc-project';
  },
}));

const CONNECTION = {
  name: 'projects/p/locations/us-central1/connections/jira',
  serviceDirectory: 'plain-directory',
  tlsServiceDirectory: 'tls-directory',
  host: 'jira.host.example',
};

const ENTITY_SCHEMA = {
  type: 'object',
  properties: {id: {type: 'integer'}, summary: {type: 'string'}},
};

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {get: () => 'application/json'},
    json: async () => body,
  };
}

/** Replays the Connectors metadata calls, then the connector execution. */
function stubConnectorsApi() {
  const fetch = vi.fn();
  fetch.mockImplementation(async (url: string) => {
    if (url.includes('?view=BASIC')) {
      return jsonResponse(CONNECTION);
    }
    if (url.includes('connectionSchemaMetadata:getEntityType')) {
      return jsonResponse({name: 'operations/1'});
    }
    if (url.includes('/v1/operations/1')) {
      return jsonResponse({
        done: true,
        response: {jsonSchema: ENTITY_SCHEMA, operations: ['LIST']},
      });
    }
    return jsonResponse({
      connectorOutputPayload: [{id: 7, summary: 'a bug'}],
    });
  });
  globalThis.fetch = fetch;
  return fetch;
}

function modelResponses(toolName: string): RawGenerateContentResponse[] {
  return [
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: toolName,
                  args: {page_size: 5},
                  id: 'adk-mock-call-1',
                },
              },
            ],
            role: 'model',
          },
          finishReason: FinishReason.STOP,
        },
      ],
    },
    {
      candidates: [
        {
          content: {parts: [{text: 'There is one open bug.'}], role: 'model'},
          finishReason: FinishReason.STOP,
        },
      ],
    },
  ];
}

describe('ApplicationIntegrationToolset in an agent', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drives a connector call from a model function call', async () => {
    const fetch = stubConnectorsApi();
    const toolset = new ApplicationIntegrationToolset({
      project: 'p',
      location: 'us-central1',
      connection: 'jira',
      entityOperations: {Issues: ['LIST']},
      toolNamePrefix: 'jira',
    });

    const tools = await toolset.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(['jira_list__issues']);

    const agent = new LlmAgent({
      model: new GeminiWithMockResponses(modelResponses('jira_list__issues')),
      name: 'jira_agent',
      description: 'lists Jira issues',
      instruction: 'use the tool to list issues',
      tools: [toolset],
    });

    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: 'ADKTest',
      userId: 'TestUser',
      sessionId: '1',
    });
    const runner = new Runner({
      appName: 'ADKTest',
      agent,
      sessionService,
    });

    for await (const _event of runner.runAsync({
      userId: 'TestUser',
      sessionId: '1',
      newMessage: {role: 'user', parts: [{text: 'list the issues'}]},
    })) {
      // Consume the events.
    }

    const executeCall = fetch.mock.calls.find(([url]) =>
      String(url).includes(':execute'),
    );
    if (!executeCall) {
      expect.fail('the agent never called the connector');
    }
    const [url, init] = executeCall as [
      string,
      {method: string; headers: Record<string, string>; body: string},
    ];

    expect(url).toBe(
      'https://integrations.googleapis.com/v2/projects/p/locations/' +
        'us-central1/integrations/ExecuteConnection:execute' +
        '?triggerId=api_trigger%2FExecuteConnection',
    );
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer adc-token');
    expect(JSON.parse(init.body)).toEqual({
      pageSize: 5,
      connectionName: 'projects/p/locations/us-central1/connections/jira',
      serviceName: 'tls-directory',
      host: 'jira.host.example',
      entity: 'Issues',
      operation: 'LIST_ENTITIES',
    });

    await toolset.close();
  });
});
