/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApplicationIntegrationToolset,
  BaseTool,
  Context,
  createSession,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient() {
      return Promise.resolve({
        getAccessToken: () => Promise.resolve({token: 'test_token'}),
        quotaProjectId: undefined,
      });
    }
    getProjectId() {
      return Promise.resolve('adc-project');
    }
  },
  JWT: class {
    getAccessToken() {
      return Promise.resolve({token: 'test_token'});
    }
    authorize() {
      return Promise.resolve({access_token: 'test_token'});
    }
  },
}));

const ENTITY_SCHEMA = {
  type: 'object',
  properties: {
    id: {type: 'string'},
    summary: {type: ['string', 'null']},
  },
};

const EXECUTE_URL =
  'https://integrations.googleapis.com/v2/projects/test-project/locations/' +
  'us-central1/integrations/ExecuteConnection:execute';

const GENERATE_SPEC_URL =
  'https://us-central1-integrations.googleapis.com/v1/projects/test-project/' +
  'locations/us-central1:generateOpenApiSpec';

const RUN_INTEGRATION_URL =
  'https://us-central1-integrations.googleapis.com/v1/projects/test-project/' +
  'locations/us-central1/integrations/test-integration:execute';

/** Two API triggers, in the shape `:generateOpenApiSpec` returns them. */
const INTEGRATION_SPEC = {
  openapi: '3.0.1',
  info: {title: 'test-integration', version: '1.0.0'},
  servers: [{url: 'https://us-central1-integrations.googleapis.com'}],
  paths: {
    [`/v1/projects/test-project/locations/us-central1/integrations/test-integration:execute?triggerId=api_trigger/create_issue`]:
      {
        post: {
          operationId: 'create_issue',
          summary: 'Creates an issue',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['summary'],
                  properties: {
                    summary: {type: 'string'},
                    priority: {type: 'integer'},
                  },
                },
              },
            },
          },
          responses: {'200': {description: 'ok'}},
        },
      },
    [`/v1/projects/test-project/locations/us-central1/integrations/test-integration:execute?triggerId=api_trigger/close_issue`]:
      {
        post: {
          operationId: 'close_issue',
          summary: 'Closes an issue',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {issue_id: {type: 'string'}},
                },
              },
            },
          },
          responses: {'200': {description: 'ok'}},
        },
      },
  },
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

/** Answers the connector metadata calls and records the executed request. */
function stubConnectorApi() {
  return vi.fn().mockImplementation((url: string) => {
    if (url.includes('/connections/test-connection?view=BASIC')) {
      return Promise.resolve(
        jsonResponse({
          name: 'projects/test-project/locations/us-central1/connections/test-connection',
          serviceDirectory: 'service-directory',
          authOverrideEnabled: false,
        }),
      );
    }
    if (url.includes(':getEntityType')) {
      return Promise.resolve(jsonResponse({name: 'operations/entity'}));
    }
    if (url.includes('/v1/operations/entity')) {
      return Promise.resolve(
        jsonResponse({
          done: true,
          response: {jsonSchema: ENTITY_SCHEMA, operations: ['LIST', 'GET']},
        }),
      );
    }
    if (url.startsWith(EXECUTE_URL)) {
      return Promise.resolve(jsonResponse({executed: true}));
    }
    return Promise.reject(new Error(`unexpected request: ${url}`));
  });
}

/** Answers `:generateOpenApiSpec` and the generated execute endpoint. */
function stubIntegrationApi() {
  return vi.fn().mockImplementation((url: string) => {
    if (url.startsWith(GENERATE_SPEC_URL)) {
      return Promise.resolve(
        jsonResponse({openApiSpec: JSON.stringify(INTEGRATION_SPEC)}),
      );
    }
    if (url.startsWith(RUN_INTEGRATION_URL)) {
      return Promise.resolve(jsonResponse({executed: true}));
    }
    return Promise.reject(new Error(`unexpected request: ${url}`));
  });
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.0-flash'}),
      session: createSession({id: 'session', appName: 'app', userId: 'user'}),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
    }),
    functionCallId: 'function-call-1',
  });
}

function toolNamed(tools: BaseTool[], name: string): BaseTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    return expect.fail(`the toolset built no tool named ${name}`);
  }
  return tool;
}

describe('ApplicationIntegrationToolset over a stubbed integration API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns the generated spec into callable tools', async () => {
    globalThis.fetch = stubIntegrationApi();
    const toolset = new ApplicationIntegrationToolset({
      project: 'test-project',
      location: 'us-central1',
      integration: 'test-integration',
      triggers: ['api_trigger/create_issue', 'api_trigger/close_issue'],
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'create_issue',
      'close_issue',
    ]);
    const declaration = toolNamed(tools, 'create_issue')._getDeclaration();
    expect(Object.keys(declaration?.parameters?.properties ?? {})).toEqual([
      'summary',
      'priority',
    ]);
    expect(declaration?.parameters?.required).toEqual(['summary']);
  });

  it('calls the trigger with an access token', async () => {
    const fetchMock = stubIntegrationApi();
    globalThis.fetch = fetchMock;
    const toolset = new ApplicationIntegrationToolset({
      project: 'test-project',
      location: 'us-central1',
      integration: 'test-integration',
      triggers: ['api_trigger/create_issue'],
    });
    const tools = await toolset.getTools();

    const result = await toolNamed(tools, 'create_issue').runAsync({
      args: {summary: 'a new issue'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({executed: true});
    const specCall = fetchMock.mock.calls[0];
    expect(JSON.parse(String(specCall[1].body))).toEqual({
      apiTriggerResources: [
        {
          integrationResource: 'test-integration',
          triggerId: ['api_trigger/create_issue'],
        },
      ],
      fileFormat: 'JSON',
    });
    const executeCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).startsWith(RUN_INTEGRATION_URL),
    );
    if (!executeCall) {
      return expect.fail('the tool never called the trigger endpoint');
    }
    expect(JSON.parse(String(executeCall[1].body))).toEqual({
      summary: 'a new issue',
    });
    expect(executeCall[1].headers['Authorization']).toBe('Bearer test_token');
  });
});

describe('ApplicationIntegrationToolset over a stubbed connector API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns connector metadata into callable tools', async () => {
    globalThis.fetch = stubConnectorApi();
    const toolset = new ApplicationIntegrationToolset({
      project: 'test-project',
      location: 'us-central1',
      connection: 'test-connection',
      entityOperations: {Issues: []},
      toolNamePrefix: 'jira',
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'jira_get__issues',
      'jira_list__issues',
    ]);
    const declaration = toolNamed(tools, 'jira_list__issues')._getDeclaration();
    expect(declaration?.description).toContain('Returns the list of Issues');
    expect(
      Object.keys(declaration?.parameters?.properties ?? {}).sort(),
    ).toEqual(['filter_clause', 'page_size', 'page_token', 'sort_by_columns']);
  });

  it('sends the connection identity in camelCase on the wire', async () => {
    const fetchMock = stubConnectorApi();
    globalThis.fetch = fetchMock;
    const toolset = new ApplicationIntegrationToolset({
      project: 'test-project',
      location: 'us-central1',
      connection: 'test-connection',
      entityOperations: {Issues: ['LIST']},
    });
    const tools = await toolset.getTools();

    const result = await toolNamed(tools, 'list__issues').runAsync({
      args: {page_size: 10},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({executed: true});
    const executeCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).startsWith(EXECUTE_URL),
    );
    if (!executeCall) {
      return expect.fail('the tool never called the execute endpoint');
    }
    // The generated path's `#list_Issues` fragment keeps the spec paths
    // unique; it must not reach the trigger id.
    expect(String(executeCall[0])).toBe(
      `${EXECUTE_URL}?triggerId=api_trigger%2FExecuteConnection`,
    );
    expect(executeCall[1].method).toBe('POST');
    expect(JSON.parse(String(executeCall[1].body))).toEqual({
      pageSize: 10,
      connectionName:
        'projects/test-project/locations/us-central1/connections/test-connection',
      serviceName: 'service-directory',
      host: '',
      entity: 'Issues',
      operation: 'LIST_ENTITIES',
    });
    expect(executeCall[1].headers['Authorization']).toBe('Bearer test_token');
  });
});
