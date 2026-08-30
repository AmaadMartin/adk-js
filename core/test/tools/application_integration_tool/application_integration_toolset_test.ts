/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApplicationIntegrationToolset,
  AuthCredential,
  AuthCredentialTypes,
  BaseTool,
  Context,
  createSession,
  InMemorySessionService,
  InputValidationError,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ConnectionDetails} from '../../../src/tools/application_integration_tool/clients/connections_client.js';
import {asJsonObject} from '../../../src/utils/json_utils.js';
import {logger} from '../../../src/utils/logger.js';

const getOpenApiSpecForIntegration = vi.fn();
const getOpenApiSpecForConnection = vi.fn();
const getConnectionDetails = vi.fn();
const openApiToolsetOptions = vi.fn();

vi.mock(
  '../../../src/tools/application_integration_tool/clients/integration_client.js',
  () => ({
    IntegrationClient: class {
      getOpenApiSpecForIntegration() {
        return getOpenApiSpecForIntegration();
      }
      getOpenApiSpecForConnection(
        toolName?: string,
        toolInstructions?: string,
      ) {
        return getOpenApiSpecForConnection(toolName, toolInstructions);
      }
      getConnectionDetails() {
        return getConnectionDetails();
      }
    },
  }),
);

vi.mock(
  '../../../src/tools/openapi_tool/openapi_toolset.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../src/tools/openapi_tool/openapi_toolset.js')
      >();
    return {
      ...actual,
      OpenAPIToolset: class extends actual.OpenAPIToolset {
        constructor(
          options: ConstructorParameters<typeof actual.OpenAPIToolset>[0],
        ) {
          openApiToolsetOptions(options);
          super(options);
        }
      },
    };
  },
);

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient() {
      return Promise.resolve({
        getAccessToken: () => Promise.resolve({token: 'service_account_token'}),
      });
    }
  },
  JWT: class {
    authorize() {
      return Promise.resolve({access_token: 'service_account_token'});
    }
  },
}));

const CONNECTION_DETAILS: ConnectionDetails = {
  name: 'projects/p/locations/l/connections/c',
  serviceName: 'service-directory',
  host: 'test.host.com',
  authOverrideEnabled: false,
};

const BEARER_SCHEME: OpenAPIV3.HttpSecurityScheme = {
  type: 'http',
  scheme: 'bearer',
};

const END_USER_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'bearer', credentials: {token: 'end-user-token'}},
};

const SERVICE_ACCOUNT_KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'test-key-id',
  private_key: 'test-key',
  client_email: 'test@example.com',
  client_id: 'test-client-id',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/sa',
  universe_domain: 'googleapis.com',
});

const INTEGRATION_SPEC: OpenAPIV3.Document = {
  openapi: '3.0.1',
  info: {title: 'Integration', version: '1'},
  servers: [{url: 'https://integrations.googleapis.com'}],
  paths: {
    '/v1/run': {
      post: {
        operationId: 'run_integration',
        summary: 'Runs the integration',
        responses: {'200': {description: 'ok'}},
      },
    },
  },
};

/** Request body of a generated connector operation. */
const EXECUTE_REQUEST_BODY: OpenAPIV3.RequestBodyObject = {
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          connectionName: {type: 'string'},
          serviceName: {type: 'string'},
          host: {type: 'string'},
          entity: {type: 'string'},
          operation: {type: 'string'},
          action: {type: 'string'},
          dynamicAuthConfig: {type: 'object'},
        },
      },
    },
  },
};

/** A generated connector spec with one entity operation and one action. */
function connectorSpec(): OpenAPIV3.Document {
  return {
    openapi: '3.0.1',
    info: {title: 'ExecuteConnection', version: '4'},
    servers: [{url: 'https://integrations.googleapis.com'}],
    paths: {
      '/v2/list:execute?triggerId=api_trigger/ExecuteConnection#list_Issues': {
        post: {
          operationId: 'jira_list_Issues',
          summary: 'List Issues',
          description: 'Lists the issues',
          requestBody: EXECUTE_REQUEST_BODY,
          responses: {'200': {description: 'ok'}},
          ...{'x-operation': 'LIST_ENTITIES', 'x-entity': 'Issues'},
        },
      },
      '/v2/action:execute': {
        post: {
          operationId: 'jira_CustomAction',
          summary: 'CustomAction',
          description: 'Runs the action',
          requestBody: EXECUTE_REQUEST_BODY,
          responses: {'200': {description: 'ok'}},
          ...{'x-operation': 'EXECUTE_ACTION', 'x-action': 'CustomAction'},
        },
      },
    },
  };
}

function createInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.0-flash'}),
    session: createSession({id: 'session', appName: 'app', userId: 'user'}),
    pluginManager: new PluginManager([]),
    sessionService: new InMemorySessionService(),
  });
}

/** Stubs `fetch` with a JSON response and returns the mock. */
function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: {get: () => 'application/json'},
    json: async () => ({result: 'ok'}),
  });
  globalThis.fetch = fetchMock;
  return fetchMock;
}

/** Runs a tool and returns the URL and JSON body of the request it sent. */
async function runAndCaptureRequest(
  tool: BaseTool,
): Promise<{url: string; body: unknown}> {
  const fetchMock = stubFetch();
  await tool.runAsync({
    args: {},
    toolContext: new Context({
      invocationContext: createInvocationContext(),
      functionCallId: 'function-call-1',
    }),
  });
  const body: unknown = fetchMock.mock.calls[0]?.[1]?.body;
  if (typeof body !== 'string') {
    return expect.fail('the tool sent no JSON body');
  }
  return {url: String(fetchMock.mock.calls[0]?.[0]), body: JSON.parse(body)};
}

/**
 * Runs a tool inside a caller-supplied invocation, so several calls share one
 * session state, and returns the JSON body of the request it sent.
 */
async function runInSession(
  tool: BaseTool,
  invocationContext: InvocationContext,
  functionCallId: string,
): Promise<unknown> {
  const fetchMock = stubFetch();
  await tool.runAsync({
    args: {},
    toolContext: new Context({invocationContext, functionCallId}),
  });
  const body: unknown = fetchMock.mock.calls[0]?.[1]?.body;
  if (typeof body !== 'string') {
    return expect.fail('the tool sent no JSON body');
  }
  return JSON.parse(body);
}

/** Narrows a captured constructor argument to an auth credential. */
function isAuthCredential(value: unknown): value is AuthCredential {
  const record = asJsonObject(value);
  return (
    record !== undefined &&
    Object.values<unknown>(AuthCredentialTypes).includes(record['authType'])
  );
}

/** Returns the options the toolset built its inner OpenAPI toolset with. */
function capturedOpenApiToolsetOptions(): Record<string, unknown> {
  const options = asJsonObject(openApiToolsetOptions.mock.calls[0]?.[0]);
  if (!options) {
    return expect.fail('no OpenAPIToolset was constructed');
  }
  return options;
}

/** Returns the credential the toolset configured its generated tools with. */
function capturedAuthCredential(): AuthCredential {
  const credential = capturedOpenApiToolsetOptions()['authCredential'];
  if (!isAuthCredential(credential)) {
    return expect.fail('no credential was configured');
  }
  return credential;
}

describe('ApplicationIntegrationToolset', () => {
  beforeEach(() => {
    getOpenApiSpecForIntegration.mockResolvedValue(INTEGRATION_SPEC);
    getOpenApiSpecForConnection.mockResolvedValue(connectorSpec());
    getConnectionDetails.mockResolvedValue(CONNECTION_DETAILS);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('argument validation', () => {
    it('rejects a toolset with neither an integration nor a connection', () => {
      expect(
        () =>
          new ApplicationIntegrationToolset({
            project: 'test-project',
            location: 'us-central1',
          }),
      ).toThrow(
        new InputValidationError(
          'Invalid request, Either integration or (connection' +
            ' and (entityOperations or actions)) should be provided.',
        ),
      );
    });

    it('accepts an integration with no triggers', () => {
      expect(
        () =>
          new ApplicationIntegrationToolset({
            project: 'test-project',
            location: 'us-central1',
            integration: 'test-integration',
          }),
      ).not.toThrow();
    });

    it('accepts an integration with an empty trigger list', () => {
      expect(
        () =>
          new ApplicationIntegrationToolset({
            project: 'test-project',
            location: 'us-central1',
            integration: 'test-integration',
            triggers: [],
          }),
      ).not.toThrow();
    });

    it('rejects a connection with no entity operations and no actions', () => {
      expect(
        () =>
          new ApplicationIntegrationToolset({
            project: 'test-project',
            location: 'us-central1',
            connection: 'test-connection',
            entityOperations: {},
            actions: [],
          }),
      ).toThrow(InputValidationError);
    });

    it('rejects a connection with no operations configured at all', () => {
      expect(
        () =>
          new ApplicationIntegrationToolset({
            project: 'test-project',
            location: 'us-central1',
            connection: 'test-connection',
          }),
      ).toThrow(InputValidationError);
    });

    it('rejects entity operations without a connection', () => {
      expect(
        () =>
          new ApplicationIntegrationToolset({
            project: 'test-project',
            location: 'us-central1',
            entityOperations: {Issues: []},
          }),
      ).toThrow(InputValidationError);
    });

    it('accepts a connection with only actions', () => {
      expect(
        () =>
          new ApplicationIntegrationToolset({
            project: 'test-project',
            location: 'us-central1',
            connection: 'test-connection',
            actions: ['CustomAction'],
          }),
      ).not.toThrow();
    });
  });

  describe('integration mode', () => {
    it('builds one tool per API trigger', async () => {
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
        triggers: ['api_trigger/test'],
        credentialKey: 'my-key',
      });

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['run_integration']);
      expect(getOpenApiSpecForIntegration).toHaveBeenCalledTimes(1);
      expect(getConnectionDetails).not.toHaveBeenCalled();
      expect(capturedOpenApiToolsetOptions()['credentialKey']).toBe('my-key');
    });

    it('builds tools for an integration given without triggers', async () => {
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
      });

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['run_integration']);
      expect(getOpenApiSpecForIntegration).toHaveBeenCalledTimes(1);
      expect(getConnectionDetails).not.toHaveBeenCalled();
    });

    it('applies a tool name filter', async () => {
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
        triggers: [],
        toolFilter: ['other_tool'],
      });

      expect(await toolset.getTools()).toEqual([]);
    });

    it('keeps a tool the name filter names', async () => {
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
        triggers: [],
        toolFilter: ['run_integration'],
      });

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['run_integration']);
    });

    it('owns the filter instead of delegating it to the inner toolset', async () => {
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
        triggers: [],
        toolFilter: ['other_tool'],
      });

      await toolset.getTools();

      expect(capturedOpenApiToolsetOptions()['toolFilter']).toBeUndefined();
    });

    it('runs the initialization once for repeated callers', async () => {
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
        triggers: [],
      });

      await toolset.getTools();
      await toolset.getTools();

      expect(getOpenApiSpecForIntegration).toHaveBeenCalledTimes(1);
    });

    it('retries the initialization after a failed one', async () => {
      getOpenApiSpecForIntegration.mockReset();
      getOpenApiSpecForIntegration
        .mockRejectedValueOnce(new Error('transient 503'))
        .mockResolvedValueOnce(INTEGRATION_SPEC);
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
        triggers: [],
      });

      await expect(toolset.getTools()).rejects.toThrow('transient 503');
      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['run_integration']);
      expect(getOpenApiSpecForIntegration).toHaveBeenCalledTimes(2);
    });

    it('shares one failed initialization with concurrent callers', async () => {
      getOpenApiSpecForIntegration.mockReset();
      getOpenApiSpecForIntegration.mockRejectedValue(
        new Error('transient 503'),
      );
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
        triggers: [],
      });

      const results = await Promise.allSettled([
        toolset.getTools(),
        toolset.getTools(),
      ]);

      expect(results.map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
      ]);
      expect(getOpenApiSpecForIntegration).toHaveBeenCalledTimes(1);
    });

    it('closes the inner OpenAPI toolset', async () => {
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
        triggers: [],
      });
      await toolset.getTools();

      await expect(toolset.close()).resolves.toBeUndefined();
    });

    it('closes without an initialization', async () => {
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
        triggers: [],
      });

      await expect(toolset.close()).resolves.toBeUndefined();
      expect(getOpenApiSpecForIntegration).not.toHaveBeenCalled();
    });

    it('waits for an initialization that close races', async () => {
      let releaseSpec: (spec: OpenAPIV3.Document) => void = () => {};
      getOpenApiSpecForIntegration.mockReset();
      getOpenApiSpecForIntegration.mockReturnValueOnce(
        new Promise<OpenAPIV3.Document>((resolve) => {
          releaseSpec = resolve;
        }),
      );
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
        triggers: [],
      });

      const pendingTools = toolset.getTools();
      const closed = toolset.close();
      releaseSpec(INTEGRATION_SPEC);
      await pendingTools;

      await expect(closed).resolves.toBeUndefined();
    });

    it('does not serve tools built before close', async () => {
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
        triggers: [],
      });
      await toolset.getTools();

      await toolset.close();
      await toolset.getTools();

      expect(getOpenApiSpecForIntegration).toHaveBeenCalledTimes(2);
    });
  });

  describe('connection mode', () => {
    function createToolset(
      overrides: Partial<
        ConstructorParameters<typeof ApplicationIntegrationToolset>[0]
      > = {},
    ): ApplicationIntegrationToolset {
      return new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        connection: 'test-connection',
        entityOperations: {Issues: []},
        ...overrides,
      });
    }

    it('builds a connector tool per generated operation', async () => {
      const tools = await createToolset().getTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        'jira_list__issues',
        'jira__custom_action',
      ]);
      expect(openApiToolsetOptions).not.toHaveBeenCalled();
    });

    it('sends the connection identity of an entity operation', async () => {
      const tools = await createToolset().getTools();

      const request = await runAndCaptureRequest(tools[0]);

      expect(request.body).toEqual({
        connectionName: 'projects/p/locations/l/connections/c',
        serviceName: 'service-directory',
        host: 'test.host.com',
        entity: 'Issues',
        operation: 'LIST_ENTITIES',
      });
      // The path fragment keeps the generated paths unique. It must not reach
      // the trigger id.
      expect(request.url).toBe(
        'https://integrations.googleapis.com/v2/list:execute' +
          '?triggerId=api_trigger%2FExecuteConnection',
      );
    });

    it('sends the action instead of the entity for an action operation', async () => {
      const tools = await createToolset({
        actions: ['CustomAction'],
      }).getTools();

      expect((await runAndCaptureRequest(tools[1])).body).toEqual({
        connectionName: 'projects/p/locations/l/connections/c',
        serviceName: 'service-directory',
        host: 'test.host.com',
        action: 'CustomAction',
        operation: 'EXECUTE_ACTION',
      });
    });

    it('defaults the operation of a spec that declares none', async () => {
      getOpenApiSpecForConnection.mockResolvedValue({
        openapi: '3.0.1',
        info: {title: 'ExecuteConnection', version: '4'},
        servers: [{url: 'https://integrations.googleapis.com'}],
        paths: {
          '/v2/list:execute': {
            post: {
              operationId: 'untagged',
              description: 'An operation with no connector extensions',
              requestBody: EXECUTE_REQUEST_BODY,
              responses: {'200': {description: 'ok'}},
            },
          },
        },
      });
      const tools = await createToolset().getTools();

      expect((await runAndCaptureRequest(tools[0])).body).toMatchObject({
        operation: '',
      });
    });

    it('hides the connection identity from the model', async () => {
      const tools = await createToolset().getTools();

      const properties = tools[0]._getDeclaration()?.parameters?.properties;
      expect(properties).toEqual({});
    });

    it('authenticates with the service account bearer token', async () => {
      const tools = await createToolset().getTools();
      const fetchMock = stubFetch();

      await tools[0].runAsync({
        args: {},
        toolContext: new Context({
          invocationContext: createInvocationContext(),
          functionCallId: 'function-call-1',
        }),
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer service_account_token',
          }),
        }),
      );
    });

    it('forwards the tool name prefix and the instructions', async () => {
      await createToolset({
        toolNamePrefix: 'jira',
        toolInstructions: 'be careful',
      }).getTools();

      expect(getOpenApiSpecForConnection).toHaveBeenCalledWith(
        'jira',
        'be careful',
      );
    });

    it('defaults the tool name prefix and the instructions', async () => {
      await createToolset().getTools();

      expect(getOpenApiSpecForConnection).toHaveBeenCalledWith('', '');
    });

    it('runs the initialization once for concurrent callers', async () => {
      const toolset = createToolset();

      await Promise.all([toolset.getTools(), toolset.getTools()]);
      await toolset.getTools();

      expect(getOpenApiSpecForConnection).toHaveBeenCalledTimes(1);
      expect(getConnectionDetails).toHaveBeenCalledTimes(1);
    });

    it('filters tools by name', async () => {
      const tools = await createToolset({
        toolFilter: ['jira__custom_action'],
      }).getTools(new ReadonlyContext(createInvocationContext()));

      expect(tools.map((tool) => tool.name)).toEqual(['jira__custom_action']);
    });

    it('filters tools by name without a context', async () => {
      // The agent card reads the tools with no context, so a name filter has
      // to apply there too, as it does in `OpenAPIToolset`.
      const tools = await createToolset({
        toolFilter: ['jira__custom_action'],
      }).getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['jira__custom_action']);
    });

    it('filters tools by predicate', async () => {
      const tools = await createToolset({
        toolFilter: (tool) => tool.name.endsWith('__issues'),
      }).getTools(new ReadonlyContext(createInvocationContext()));

      expect(tools.map((tool) => tool.name)).toEqual(['jira_list__issues']);
    });

    it('returns every tool when no context is given', async () => {
      const tools = await createToolset({
        toolFilter: (tool) => tool.name.endsWith('__issues'),
      }).getTools();

      expect(tools).toHaveLength(2);
    });

    it('is a no-op to close', async () => {
      const toolset = createToolset();
      await toolset.getTools();

      await expect(toolset.close()).resolves.toBeUndefined();
    });
  });

  describe('end-user auth', () => {
    function createToolset(): ApplicationIntegrationToolset {
      return new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        connection: 'test-connection',
        entityOperations: {Issues: []},
        authScheme: BEARER_SCHEME,
        authCredential: END_USER_CREDENTIAL,
      });
    }

    it('drops the end-user credential when the connection forbids override', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const tools = await createToolset().getTools();

      expect(warn).toHaveBeenCalledWith(
        'Authentication schema and credentials are not used because' +
          ' authOverrideEnabled is not enabled in the connection.',
      );
      expect((await runAndCaptureRequest(tools[0])).body).not.toHaveProperty(
        'dynamicAuthConfig',
      );
    });

    it('keeps the end-user credential when the connection allows override', async () => {
      getConnectionDetails.mockResolvedValue({
        ...CONNECTION_DETAILS,
        authOverrideEnabled: true,
      });
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const tools = await createToolset().getTools();

      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining('authOverrideEnabled'),
      );
      expect((await runAndCaptureRequest(tools[0])).body).toMatchObject({
        dynamicAuthConfig: {
          'oauth2_auth_code_flow.access_token': 'end-user-token',
        },
      });
    });

    it('keeps sending the end-user token on a second call in one session', async () => {
      getConnectionDetails.mockResolvedValue({
        ...CONNECTION_DETAILS,
        authOverrideEnabled: true,
      });
      const tools = await createToolset().getTools();
      // Both calls share one session, so the second one reads back whatever
      // the first stored. The service account token must not turn up here.
      const invocationContext = createInvocationContext();

      const first = await runInSession(tools[0], invocationContext, 'call-1');
      const second = await runInSession(tools[0], invocationContext, 'call-2');

      expect(first).toMatchObject({
        dynamicAuthConfig: {
          'oauth2_auth_code_flow.access_token': 'end-user-token',
        },
      });
      expect(second).toMatchObject({
        dynamicAuthConfig: {
          'oauth2_auth_code_flow.access_token': 'end-user-token',
        },
      });
    });
  });

  describe('service account auth', () => {
    function createToolset(
      serviceAccountJson?: string,
    ): ApplicationIntegrationToolset {
      return new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
        triggers: [],
        serviceAccountJson,
      });
    }

    it('uses default credentials when no key is given', async () => {
      await createToolset().getTools();

      const credential = capturedAuthCredential();
      expect(credential.authType).toBe(AuthCredentialTypes.SERVICE_ACCOUNT);
      expect(credential.serviceAccount?.useDefaultCredential).toBe(true);
      expect(credential.serviceAccount?.scopes).toEqual([
        'https://www.googleapis.com/auth/cloud-platform',
      ]);
      expect(capturedOpenApiToolsetOptions()['authScheme']).toEqual({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      });
    });

    it('rejects a key that is not JSON before any request', () => {
      expect(() => createToolset('not json')).toThrow(
        new InputValidationError('Service account key is not valid JSON.'),
      );
      expect(getOpenApiSpecForIntegration).not.toHaveBeenCalled();
    });

    it('rejects a key with no client email before any request', () => {
      const key = JSON.parse(SERVICE_ACCOUNT_KEY) as Record<string, unknown>;
      delete key['client_email'];

      expect(() => createToolset(JSON.stringify(key))).toThrow(
        new InputValidationError(
          'Service account key is missing the required field "clientEmail".',
        ),
      );
      expect(getOpenApiSpecForIntegration).not.toHaveBeenCalled();
    });

    it('converts a service account key to the credential interface', async () => {
      await createToolset(SERVICE_ACCOUNT_KEY).getTools();

      const credential = capturedAuthCredential();
      expect(credential.authType).toBe(AuthCredentialTypes.SERVICE_ACCOUNT);
      expect(credential.serviceAccount?.serviceAccountCredential).toMatchObject(
        {
          type: 'service_account',
          projectId: 'test-project',
          privateKey: 'test-key',
          clientEmail: 'test@example.com',
        },
      );
      expect(credential.serviceAccount?.useDefaultCredential).toBeUndefined();
    });
  });
});
