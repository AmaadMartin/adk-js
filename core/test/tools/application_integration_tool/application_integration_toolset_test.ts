/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApplicationIntegrationToolset,
  AuthCredentialTypes,
  BaseTool,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../../src/utils/logger.js';

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

const KEY_FILE = JSON.stringify({
  'type': 'service_account',
  'project_id': 'dummy',
  'private_key': 'dummy-key',
  'client_email': 'test@example.com',
});

const AUTH_OVERRIDE_WARNING =
  'Authentication schema and credentials are not used because' +
  ' authOverrideEnabled is not enabled in the connection.';

const BEARER_SCHEME: OpenAPIV3.SecuritySchemeObject = {
  type: 'http',
  scheme: 'bearer',
};

const USER_CREDENTIAL = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'bearer', credentials: {token: 'user-token'}},
};

/** A minimal generated spec, as `:generateOpenApiSpec` returns it. */
function integrationSpec(operationIds: string[]): string {
  const paths: Record<string, unknown> = {};
  for (const operationId of operationIds) {
    paths[`/v1/${operationId}`] = {
      post: {operationId, description: `runs ${operationId}`, responses: {}},
    };
  }
  return JSON.stringify({
    openapi: '3.0.1',
    info: {title: 'test', version: '1'},
    servers: [{url: 'https://us-central1-integrations.googleapis.com'}],
    paths,
  });
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {get: () => 'application/json'},
    json: async () => body,
  };
}

interface RouteOptions {
  connection?: Record<string, unknown>;
  entityOperations?: string[];
  actionDisplayName?: string;
  generatedSpec?: string;
}

/**
 * Answers each Connectors, Integrations and tool call by URL, so a test does
 * not depend on the order the toolset makes them in.
 */
function routeFetch(options: RouteOptions = {}) {
  const {
    connection = {
      name: 'projects/p/locations/us-central1/connections/test-connection',
      serviceDirectory: 'plain-directory',
      host: '',
    },
    entityOperations = ['LIST'],
    actionDisplayName = 'CustomAction',
    generatedSpec = integrationSpec(['test_trigger']),
  } = options;

  const fetch = vi.fn();
  fetch.mockImplementation(async (url: string) => {
    if (url.includes(':generateOpenApiSpec')) {
      return jsonResponse({openApiSpec: generatedSpec});
    }
    if (url.includes('?view=BASIC')) {
      return jsonResponse(connection);
    }
    if (url.includes('connectionSchemaMetadata:getEntityType')) {
      return jsonResponse({name: 'operations/entity'});
    }
    if (url.includes('connectionSchemaMetadata:getAction')) {
      return jsonResponse({name: 'operations/action'});
    }
    if (url.includes('/v1/operations/entity')) {
      return jsonResponse({
        done: true,
        response: {
          jsonSchema: {type: 'object', properties: {id: {type: 'integer'}}},
          operations: entityOperations,
        },
      });
    }
    if (url.includes('/v1/operations/action')) {
      return jsonResponse({
        done: true,
        response: {
          inputJsonSchema: {type: 'object'},
          outputJsonSchema: {type: 'object'},
          description: 'runs a thing',
          displayName: actionDisplayName,
        },
      });
    }
    return jsonResponse({called: url});
  });
  globalThis.fetch = fetch;
  return fetch;
}

type ToolsetOptions = ConstructorParameters<
  typeof ApplicationIntegrationToolset
>[0];

function createIntegrationToolset(overrides: Partial<ToolsetOptions> = {}) {
  return new ApplicationIntegrationToolset({
    project: 'p',
    location: 'us-central1',
    integration: 'test-integration',
    triggers: ['api_trigger/test_trigger'],
    ...overrides,
  });
}

function createConnectionToolset(overrides: Partial<ToolsetOptions> = {}) {
  return new ApplicationIntegrationToolset({
    project: 'p',
    location: 'us-central1',
    connection: 'test-connection',
    entityOperations: {Issues: ['LIST']},
    ...overrides,
  });
}

/** A real Context, so a generated tool runs against genuine ADK plumbing. */
function createContext(): Context {
  return new Context({
    invocationContext: newInvocationContext(),
    functionCallId: 'call-1',
  });
}

/** A real ReadonlyContext, for the filters that take one. */
function createReadonlyContext(): ReadonlyContext {
  return new ReadonlyContext(newInvocationContext());
}

function newInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'invocation-1',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({id: 'session-1', appName: 'test_app'}),
    pluginManager: new PluginManager(),
  });
}

/**
 * Runs a generated tool and returns the request it sent, so a test can assert
 * what the toolset baked into the tool.
 */
async function callTool(
  tool: BaseTool,
  fetch: ReturnType<typeof routeFetch>,
  args: Record<string, unknown> = {},
): Promise<{url: string; headers: Record<string, string>; body: unknown}> {
  const callsBefore = fetch.mock.calls.length;
  await tool.runAsync({args, toolContext: createContext()});

  const call = fetch.mock.calls[callsBefore];
  if (!call) {
    expect.fail(`${tool.name} sent no request`);
  }
  const [url, init] = call as [
    string,
    {headers: Record<string, string>; body?: string},
  ];
  return {
    url,
    headers: init.headers,
    body: init.body ? JSON.parse(init.body) : undefined,
  };
}

describe('ApplicationIntegrationToolset', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('construction', () => {
    it.each([
      {options: {}, case: 'neither an integration nor a connection'},
      {options: {triggers: ['t']}, case: 'triggers with no integration'},
      {options: {connection: 'c'}, case: 'a connection with no work'},
      {
        options: {connection: 'c', entityOperations: {}, actions: []},
        case: 'a connection with empty operations and actions',
      },
    ])('rejects $case', ({options}) => {
      expect(
        () =>
          new ApplicationIntegrationToolset({
            project: 'p',
            location: 'us-central1',
            ...options,
          }),
      ).toThrow(
        'Invalid request, Either integration or (connection and' +
          ' (entity_operations or actions)) should be provided.',
      );
    });

    it('makes no request until getTools is called', () => {
      const fetch = routeFetch();

      createIntegrationToolset();

      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('integration mode', () => {
    it('returns a tool per API trigger and never reads the connection', async () => {
      const fetch = routeFetch();

      const tools = await createIntegrationToolset().getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['test_trigger']);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0]).toContain(':generateOpenApiSpec');
    });

    it('returns a tool for each of several triggers, in spec order', async () => {
      routeFetch({generatedSpec: integrationSpec(['first', 'second'])});

      const tools = await createIntegrationToolset({
        triggers: ['api_trigger/first', 'api_trigger/second'],
      }).getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['first', 'second']);
    });

    it('calls the trigger endpoint with the supplied service account token', async () => {
      const fetch = routeFetch();

      const tools = await createIntegrationToolset({
        serviceAccountJson: KEY_FILE,
      }).getTools();
      const request = await callTool(tools[0], fetch);

      expect(request.url).toBe(
        'https://us-central1-integrations.googleapis.com/v1/test_trigger',
      );
      expect(request.headers['Authorization']).toBe('Bearer sa-token');
    });

    it('calls the trigger endpoint with the default credential token', async () => {
      const fetch = routeFetch();

      const tools = await createIntegrationToolset().getTools();
      const request = await callTool(tools[0], fetch);

      expect(request.headers['Authorization']).toBe('Bearer adc-token');
    });

    it('honours a tool name filter', async () => {
      routeFetch({generatedSpec: integrationSpec(['first', 'second'])});

      const tools = await createIntegrationToolset({
        toolFilter: ['second'],
      }).getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['second']);
    });
  });

  describe('connection mode', () => {
    it('sends the connection, entity and operation the tool was built with', async () => {
      const fetch = routeFetch({
        connection: {
          name: 'projects/p/locations/us-central1/connections/test-connection',
          serviceDirectory: 'plain-directory',
          tlsServiceDirectory: 'tls-directory',
          host: 'my.host.example',
        },
      });

      const tools = await createConnectionToolset().getTools();
      expect(tools.map((tool) => tool.name)).toEqual(['list__issues']);
      const request = await callTool(tools[0], fetch, {page_size: 10});

      expect(request.url).toBe(
        'https://integrations.googleapis.com/v2/projects/p/locations/' +
          'us-central1/integrations/ExecuteConnection:execute' +
          '?triggerId=api_trigger%2FExecuteConnection',
      );
      expect(request.body).toEqual({
        pageSize: 10,
        connectionName:
          'projects/p/locations/us-central1/connections/test-connection',
        serviceName: 'tls-directory',
        host: 'my.host.example',
        entity: 'Issues',
        operation: 'LIST_ENTITIES',
      });
      expect(request.headers['Authorization']).toBe('Bearer adc-token');
    });

    it('sends the action instead of the entity for an action tool', async () => {
      const fetch = routeFetch();

      const tools = await new ApplicationIntegrationToolset({
        project: 'p',
        location: 'us-central1',
        connection: 'test-connection',
        actions: ['CustomAction'],
      }).getTools();
      const request = await callTool(tools[0], fetch);

      expect(request.body).toMatchObject({
        action: 'CustomAction',
        operation: 'EXECUTE_ACTION',
      });
      expect(request.body).not.toHaveProperty('entity');
    });

    it('prefixes the tool name and appends the instructions', async () => {
      routeFetch();

      const tools = await createConnectionToolset({
        toolNamePrefix: 'jira',
        toolInstructions: 'be careful',
      }).getTools();

      expect(tools[0].name).toBe('jira_list__issues');
      expect(tools[0].description).toContain('be careful');
    });

    it('sends the caller token when the connection allows an auth override', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const fetch = routeFetch({
        connection: {
          name: 'c',
          serviceDirectory: 'd',
          authOverrideEnabled: true,
        },
      });

      const tools = await createConnectionToolset({
        authScheme: BEARER_SCHEME,
        authCredential: USER_CREDENTIAL,
      }).getTools();
      const request = await callTool(tools[0], fetch);

      expect(request.body).toMatchObject({
        dynamicAuthConfig: {'oauth2_auth_code_flow.access_token': 'user-token'},
      });
      expect(warn.mock.calls.flat()).not.toContain(AUTH_OVERRIDE_WARNING);
    });

    it('drops the caller token and warns when the connection forbids it', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const fetch = routeFetch();

      const tools = await createConnectionToolset({
        authScheme: BEARER_SCHEME,
        authCredential: USER_CREDENTIAL,
      }).getTools();
      const request = await callTool(tools[0], fetch);

      expect(request.body).not.toHaveProperty('dynamicAuthConfig');
      expect(warn.mock.calls.flat()).toContain(AUTH_OVERRIDE_WARNING);
    });

    it('asks for a credential when a scheme is given without one', async () => {
      routeFetch();

      const tools = await createConnectionToolset({
        authScheme: BEARER_SCHEME,
      }).getTools();
      const toolContext = createContext();
      const result = await tools[0].runAsync({args: {}, toolContext});

      expect(result).toEqual({
        pending: true,
        message: 'Needs your authorization to access your data.',
      });
      expect(
        toolContext.eventActions.requestedAuthConfigs['call-1'],
      ).toBeDefined();
    });

    it('honours a tool predicate filter', async () => {
      routeFetch({entityOperations: ['LIST', 'GET']});

      const tools = await createConnectionToolset({
        entityOperations: {Issues: []},
        toolFilter: (tool) => tool.name.startsWith('get'),
      }).getTools(createReadonlyContext());

      expect(tools.map((tool) => tool.name)).toEqual(['get__issues']);
    });

    it('honours a tool name filter', async () => {
      routeFetch({entityOperations: ['LIST', 'GET']});

      const tools = await createConnectionToolset({
        entityOperations: {Issues: []},
        toolFilter: ['get__issues'],
      }).getTools(createReadonlyContext());

      expect(tools.map((tool) => tool.name)).toEqual(['get__issues']);
    });

    it('honours a tool name filter with no context', async () => {
      routeFetch({entityOperations: ['LIST', 'GET']});

      const tools = await createConnectionToolset({
        entityOperations: {Issues: []},
        toolFilter: ['get__issues'],
      }).getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['get__issues']);
    });

    it('skips a tool predicate with no context, and returns every tool', async () => {
      routeFetch({entityOperations: ['LIST', 'GET']});

      const tools = await createConnectionToolset({
        entityOperations: {Issues: []},
        toolFilter: (tool) => tool.name.startsWith('get'),
      }).getTools();

      expect(tools).toHaveLength(2);
    });

    it('returns every tool when no filter is set', async () => {
      routeFetch({entityOperations: ['LIST', 'GET']});

      const tools = await createConnectionToolset({
        entityOperations: {Issues: []},
      }).getTools();

      expect(tools).toHaveLength(2);
    });
  });

  describe('initialization', () => {
    it('reads the resource once across repeated getTools calls', async () => {
      const fetch = routeFetch();
      const toolset = createConnectionToolset();

      const [first, second] = await Promise.all([
        toolset.getTools(),
        toolset.getTools(),
      ]);
      await toolset.getTools();

      expect(first).toEqual(second);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('surfaces a failure and retries on the next call', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValue(
          jsonResponse({openApiSpec: integrationSpec(['test_trigger'])}),
        );
      const toolset = createIntegrationToolset();

      await expect(toolset.getTools()).rejects.toThrow(
        'Request error: socket hang up',
      );

      expect(await toolset.getTools()).toHaveLength(1);
    });
  });

  describe('close', () => {
    it('is safe to call twice, before and after loading', async () => {
      routeFetch();
      const toolset = createIntegrationToolset();

      await toolset.close();
      await toolset.getTools();
      await toolset.close();
      await toolset.close();
    });
  });
});
