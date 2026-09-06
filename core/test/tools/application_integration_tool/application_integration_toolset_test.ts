/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApplicationIntegrationToolset,
  ApplicationIntegrationToolsetOptions,
  AuthCredential,
  AuthCredentialTypes,
  BaseTool,
  ConnectionDetails,
  Context,
  createSession,
  InputValidationError,
  IntegrationConnectorTool,
  InvocationContext,
  OpenAPIToolset,
  PluginManager,
  RestApiTool,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ConnectorOperationExtensions,
  ENTITY_OPERATIONS,
  getConnectorBaseSpec,
} from '../../../src/tools/application_integration_tool/clients/connector_spec_builders.js';
import {logger} from '../../../src/utils/logger.js';

const integrationClientOptions = vi.fn();
const getConnectionDetails = vi.fn();
const getOpenApiSpecForIntegration = vi.fn();
const getOpenApiSpecForConnection = vi.fn();

vi.mock(
  '../../../src/tools/application_integration_tool/clients/integration_client.js',
  () => ({
    IntegrationClient: class {
      constructor(options: unknown) {
        integrationClientOptions(options);
      }
      getConnectionDetails() {
        return getConnectionDetails();
      }
      getOpenApiSpecForIntegration() {
        return getOpenApiSpecForIntegration();
      }
      getOpenApiSpecForConnection(toolName: string, toolInstructions: string) {
        return getOpenApiSpecForConnection(toolName, toolInstructions);
      }
    },
  }),
);

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** A complete service account key file, as the parser requires. */
const SERVICE_ACCOUNT_KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'key-project',
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

const CONNECTION_DETAILS: ConnectionDetails = {
  name: 'projects/p/locations/l/connections/jira',
  serviceName: 'services/jira',
  host: 'jira.example.com',
  authOverrideEnabled: false,
};

const END_USER_SCHEME: OpenAPIV3.SecuritySchemeObject = {
  type: 'http',
  scheme: 'bearer',
};

const END_USER_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.HTTP,
  http: {scheme: 'bearer', credentials: {token: 'raw-user-token'}},
};

/** An integration spec with two API triggers, so a filter has work to do. */
function integrationSpec(): OpenAPIV3.Document {
  return {
    openapi: '3.0.1',
    info: {title: 'test-integration', version: '1'},
    servers: [{url: 'https://integrations.googleapis.com'}],
    paths: {
      '/v1/projects/p/locations/l/integrations/i:execute': {
        post: {
          operationId: 'run_first_trigger',
          summary: 'Runs the first trigger.',
          responses: {'200': {description: 'ok'}},
        },
      },
      '/v1/projects/p/locations/l/integrations/j:execute': {
        post: {
          operationId: 'run_second_trigger',
          summary: 'Runs the second trigger.',
          responses: {'200': {description: 'ok'}},
        },
      },
    },
  };
}

/**
 * Builds a connector spec with the real builders, so the generated shape the
 * toolset parses is the one the client would have produced.
 */
function connectorSpec(
  entities: Record<string, string[]> = {Issues: ['list', 'create']},
): OpenAPIV3.Document {
  const spec = getConnectorBaseSpec();
  for (const [entity, operations] of Object.entries(entities)) {
    spec.components.schemas[`connectorInputPayload_${entity}`] = {
      type: 'object',
      properties: {summary: {type: 'string'}},
    };
    for (const operation of operations) {
      const builder = ENTITY_OPERATIONS.get(operation);
      if (!builder) {
        expect.fail(`no builder for entity operation ${operation}`);
      }
      spec.components.schemas[`${operation}_${entity}_Request`] =
        builder.request(entity);
      spec.paths[
        `/v2/projects/p/locations/l/integrations/ExecuteConnection:execute` +
          `?triggerId=api_trigger/ExecuteConnection#${operation}_${entity}`
      ] = builder.operation({
        entity,
        schemaAsString: '{}',
        toolName: 'jira',
        toolInstructions: '',
      });
    }
  }
  return spec;
}

/**
 * A connector spec carrying one action rather than an entity operation.
 * `withOperation: false` leaves out the `x-operation` extension.
 */
function actionSpec({
  withOperation = true,
}: {withOperation?: boolean} = {}): OpenAPIV3.Document<
  Partial<ConnectorOperationExtensions>
> {
  const base = getConnectorBaseSpec();
  base.components.schemas['connectorInputPayload_RunQuery'] = {type: 'object'};
  base.components.schemas['connectorOutputPayload_RunQuery'] = {
    type: 'object',
  };
  // The extensions are widened to optional, because a fixture that declares
  // no `x-operation` does not satisfy the generated spec's extension type.
  const spec: OpenAPIV3.Document<Partial<ConnectorOperationExtensions>> = base;
  spec.paths[
    '/v2/projects/p/locations/l/integrations/ExecuteConnection:execute' +
      '?triggerId=api_trigger/ExecuteConnection#RunQuery'
  ] = {
    post: {
      summary: 'RunQuery',
      operationId: 'jira_RunQuery',
      ...(withOperation ? {'x-operation': 'EXECUTE_ACTION'} : {}),
      'x-action': 'RunQuery',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                operation: {type: 'string'},
                connectionName: {type: 'string'},
                serviceName: {type: 'string'},
                host: {type: 'string'},
                action: {type: 'string'},
              },
            },
          },
        },
      },
      responses: {'200': {description: 'ok'}},
    },
  };
  return spec;
}

function createToolset(
  overrides: Partial<ApplicationIntegrationToolsetOptions> = {},
): ApplicationIntegrationToolset {
  return new ApplicationIntegrationToolset({
    project: 'test-project',
    location: 'us-central1',
    connection: 'jira',
    entityOperations: {Issues: ['list', 'create']},
    ...overrides,
  });
}

/** A tool context whose session state already holds `slots`. */
function createContext(slots: Record<string, AuthCredential> = {}): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({
        id: 'session-1',
        appName: 'test-app',
        state: {...slots},
      }),
      pluginManager: new PluginManager(),
    }),
    functionCallId: 'call-1',
  });
}

function bearer(token: string): AuthCredential {
  return {
    authType: AuthCredentialTypes.HTTP,
    http: {scheme: 'bearer', credentials: {token}},
  };
}

/** Narrows a tool to the connector tool the connection mode builds. */
function asConnectorTool(tool: BaseTool): IntegrationConnectorTool {
  if (!(tool instanceof IntegrationConnectorTool)) {
    expect.fail(`expected an IntegrationConnectorTool, got ${tool.name}`);
  }
  return tool;
}

beforeEach(() => {
  vi.clearAllMocks();
  getConnectionDetails.mockResolvedValue(CONNECTION_DETAILS);
  getOpenApiSpecForConnection.mockResolvedValue(connectorSpec());
  getOpenApiSpecForIntegration.mockResolvedValue(integrationSpec());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApplicationIntegrationToolset', () => {
  describe('argument validation', () => {
    const message =
      'Invalid request, Either integration or (connection and' +
      ' (entityOperations or actions)) should be provided.';

    it('rejects neither an integration nor a connection', () => {
      expect(
        () =>
          new ApplicationIntegrationToolset({
            project: 'test-project',
            location: 'us-central1',
          }),
      ).toThrow(new InputValidationError(message));
    });

    it('rejects triggers on their own', () => {
      expect(
        () =>
          new ApplicationIntegrationToolset({
            project: 'test-project',
            location: 'us-central1',
            triggers: ['api_trigger/test'],
          }),
      ).toThrow(InputValidationError);
    });

    it('rejects a connection on its own', () => {
      expect(
        () =>
          new ApplicationIntegrationToolset({
            project: 'test-project',
            location: 'us-central1',
            connection: 'jira',
          }),
      ).toThrow(InputValidationError);
    });

    it('rejects a connection with empty entity operations and actions', () => {
      expect(
        () =>
          new ApplicationIntegrationToolset({
            project: 'test-project',
            location: 'us-central1',
            connection: 'jira',
            entityOperations: {},
            actions: [],
          }),
      ).toThrow(InputValidationError);
    });

    it('accepts an integration with no triggers and reports the error later', async () => {
      const toolset = new ApplicationIntegrationToolset({
        project: 'test-project',
        location: 'us-central1',
        integration: 'test-integration',
      });
      getOpenApiSpecForIntegration.mockRejectedValue(
        new InputValidationError('Integration name and triggers are required.'),
      );

      await expect(toolset.getTools()).rejects.toThrow(InputValidationError);
    });

    it('rejects a malformed service account key from the constructor', () => {
      expect(() => createToolset({serviceAccountJson: 'not-json'})).toThrow(
        InputValidationError,
      );
    });
  });

  describe('integration mode', () => {
    it('builds a REST tool for every operation of the generated spec', async () => {
      const toolset = createToolset({
        connection: undefined,
        entityOperations: undefined,
        integration: 'test-integration',
        triggers: ['api_trigger/first'],
      });

      const tools = await toolset.getTools();

      expect(getOpenApiSpecForIntegration).toHaveBeenCalledTimes(1);
      expect(tools.map((tool) => tool.name)).toEqual([
        'run_first_trigger',
        'run_second_trigger',
      ]);
      expect(tools.every((tool) => tool instanceof RestApiTool)).toBe(true);
    });

    it('builds tools for several triggers and for an empty trigger list', async () => {
      for (const triggers of [['a', 'b'], []]) {
        const tools = await createToolset({
          connection: undefined,
          entityOperations: undefined,
          integration: 'test-integration',
          triggers,
        }).getTools();

        expect(tools).toHaveLength(2);
      }
    });

    it('honours a tool filter given as a name list', async () => {
      const toolset = createToolset({
        connection: undefined,
        entityOperations: undefined,
        integration: 'test-integration',
        triggers: ['api_trigger/first'],
        toolFilter: ['run_second_trigger'],
      });

      const tools = await toolset.getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['run_second_trigger']);
    });

    it('honours a tool filter given as a predicate', async () => {
      const toolset = createToolset({
        connection: undefined,
        entityOperations: undefined,
        integration: 'test-integration',
        triggers: ['api_trigger/first'],
        toolFilter: (tool) => tool.name === 'run_first_trigger',
      });

      const tools = await toolset.getTools(createContext());

      expect(tools.map((tool) => tool.name)).toEqual(['run_first_trigger']);
    });

    it('closes the OpenAPI toolset it delegates to', async () => {
      const close = vi.spyOn(OpenAPIToolset.prototype, 'close');
      const toolset = createToolset({
        connection: undefined,
        entityOperations: undefined,
        integration: 'test-integration',
        triggers: ['api_trigger/first'],
      });
      await toolset.getTools();

      await toolset.close();

      expect(close).toHaveBeenCalledTimes(1);
    });

    it('closes nothing when it was never initialized', async () => {
      const close = vi.spyOn(OpenAPIToolset.prototype, 'close');

      await createToolset().close();

      expect(close).not.toHaveBeenCalled();
    });
  });

  describe('service identity', () => {
    it('calls with the given service account key', async () => {
      const toolset = createToolset({serviceAccountJson: SERVICE_ACCOUNT_KEY});

      const credential = await capturedServiceCredential(toolset);

      expect(credential.authType).toBe(AuthCredentialTypes.SERVICE_ACCOUNT);
      expect(
        credential.serviceAccount?.serviceAccountCredential?.clientEmail,
      ).toBe('test@example.com');
      expect(credential.serviceAccount?.scopes).toEqual([CLOUD_PLATFORM_SCOPE]);
    });

    it('falls back to the default credential when no key is given', async () => {
      const credential = await capturedServiceCredential(createToolset());

      expect(credential.serviceAccount?.useDefaultCredential).toBe(true);
      expect(
        credential.serviceAccount?.serviceAccountCredential,
      ).toBeUndefined();
    });
  });

  describe('connection mode', () => {
    it('builds one connector tool per entity operation', async () => {
      const tools = await createToolset().getTools();

      expect(tools).toHaveLength(2);
      // `OperationParser` snake-cases the generated `operationId`.
      expect(tools.map((tool) => tool.name)).toEqual([
        'jira_list__issues',
        'jira_create__issues',
      ]);
      expect(
        tools.every((tool) => tool instanceof IntegrationConnectorTool),
      ).toBe(true);
    });

    it('carries the entity and the operation, and no action', async () => {
      const [tool] = await createToolset({
        entityOperations: {Issues: ['list']},
      }).getTools();

      const args = await runAndCaptureArgs(asConnectorTool(tool));

      expect(args['entity']).toBe('Issues');
      expect(args['operation']).toBe('LIST_ENTITIES');
      expect(args['action']).toBeUndefined();
    });

    it('sends an empty operation when the spec declares none', async () => {
      getOpenApiSpecForConnection.mockResolvedValue(
        actionSpec({withOperation: false}),
      );

      const [tool] = await createToolset({
        entityOperations: undefined,
        actions: ['RunQuery'],
      }).getTools();
      const args = await runAndCaptureArgs(asConnectorTool(tool));

      expect(args['operation']).toBe('');
    });

    it('carries the action, and no entity', async () => {
      getOpenApiSpecForConnection.mockResolvedValue(actionSpec());

      const [tool] = await createToolset({
        entityOperations: undefined,
        actions: ['RunQuery'],
      }).getTools();
      const args = await runAndCaptureArgs(asConnectorTool(tool));

      expect(args['action']).toBe('RunQuery');
      expect(args['operation']).toBe('EXECUTE_ACTION');
      expect(args['entity']).toBeUndefined();
    });

    it('carries the connection identity from the connection details', async () => {
      const [tool] = await createToolset().getTools();

      const args = await runAndCaptureArgs(asConnectorTool(tool));

      expect(args['connection_name']).toBe(CONNECTION_DETAILS.name);
      expect(args['host']).toBe(CONNECTION_DETAILS.host);
      expect(args['service_name']).toBe(CONNECTION_DETAILS.serviceName);
    });

    it('forwards the tool name prefix and the tool instructions', async () => {
      await createToolset({
        toolNamePrefix: 'jira',
        toolInstructions: 'Be careful.',
      }).getTools();

      expect(getOpenApiSpecForConnection).toHaveBeenCalledWith(
        'jira',
        'Be careful.',
      );
    });

    it('defaults the tool name prefix and the tool instructions to empty', async () => {
      await createToolset().getTools();

      expect(getOpenApiSpecForConnection).toHaveBeenCalledWith('', '');
    });

    it('forwards the connection template override to the client', async () => {
      createToolset({connectionTemplateOverride: 'MyExecuteConnection'});

      expect(integrationClientOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionTemplateOverride: 'MyExecuteConnection',
        }),
      );
    });

    it('honours a tool filter given as a name list', async () => {
      const tools = await createToolset({
        toolFilter: ['jira_create__issues'],
      }).getTools();

      expect(tools.map((tool) => tool.name)).toEqual(['jira_create__issues']);
    });

    it('reads the resource once however many callers race the first call', async () => {
      const toolset = createToolset();

      const [first, second] = await Promise.all([
        toolset.getTools(),
        toolset.getTools(),
      ]);

      expect(getConnectionDetails).toHaveBeenCalledTimes(1);
      expect(getOpenApiSpecForConnection).toHaveBeenCalledTimes(1);
      expect(first).toEqual(second);
    });

    it('retries after a failed initialization', async () => {
      const toolset = createToolset();
      getConnectionDetails.mockRejectedValueOnce(new Error('network down'));

      await expect(toolset.getTools()).rejects.toThrow('network down');
      const tools = await toolset.getTools();

      expect(getConnectionDetails).toHaveBeenCalledTimes(2);
      expect(tools).toHaveLength(2);
    });

    it('drops the built tools when it closes', async () => {
      const toolset = createToolset();
      await toolset.getTools();

      await toolset.close();

      expect(getConnectionDetails).toHaveBeenCalledTimes(1);
      expect(await toolset.getTools()).toHaveLength(2);
      expect(getConnectionDetails).toHaveBeenCalledTimes(2);
    });
  });

  describe('end-user auth', () => {
    it('passes the caller auth on when the connection enables the override', async () => {
      getConnectionDetails.mockResolvedValue({
        ...CONNECTION_DETAILS,
        authOverrideEnabled: true,
      });

      const [tool] = await createToolset({
        authScheme: END_USER_SCHEME,
        authCredential: END_USER_CREDENTIAL,
      }).getTools();
      const args = await runAndCaptureArgs(asConnectorTool(tool));

      expect(args['dynamic_auth_config']).toEqual({
        'oauth2_auth_code_flow.access_token': 'raw-user-token',
      });
    });

    it('drops the caller auth and warns when the override is off', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const [tool] = await createToolset({
        authScheme: END_USER_SCHEME,
        authCredential: END_USER_CREDENTIAL,
      }).getTools();
      const args = await runAndCaptureArgs(asConnectorTool(tool));

      expect(args).not.toHaveProperty('dynamic_auth_config');
      expect(warn).toHaveBeenCalledWith(
        'Authentication schema and credentials are not used because' +
          ' authOverrideEnabled is not enabled in the connection.',
      );
    });
  });

  describe('the generated spec through to the outgoing request', () => {
    let fetchStub: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchStub = vi.fn().mockResolvedValue({
        headers: {get: () => 'application/json'},
        json: () => Promise.resolve({connectorOutputPayload: {id: '1'}}),
      });
      vi.stubGlobal('fetch', fetchStub);
      getConnectionDetails.mockResolvedValue({
        ...CONNECTION_DETAILS,
        authOverrideEnabled: true,
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('sends the identities to different slots and drops the spec fragment', async () => {
      const toolset = createToolset({
        credentialKey: 'jira',
        entityOperations: {Issues: ['list']},
        authScheme: END_USER_SCHEME,
        authCredential: END_USER_CREDENTIAL,
      });
      const [tool] = await toolset.getTools();
      // Two identities call out in one session. The service account reaches
      // `ExecuteConnection`, the end user reaches the connector behind it.
      const toolContext = createContext({
        'http_jira_service_identity_existing_exchanged_credential':
          bearer('service-token'),
        'http_jira_existing_exchanged_credential': bearer('user-token'),
      });

      const result = await tool.runAsync({args: {page_size: 5}, toolContext});

      expect(result).toEqual({connectorOutputPayload: {id: '1'}});
      const [url, init] = fetchStub.mock.calls[0] as [
        string,
        {method: string; headers: Record<string, string>; body: string},
      ];
      // An HTTP request carries no fragment, so `#list_Issues` is gone.
      expect(url).toBe(
        'https://integrations.googleapis.com/v2/projects/p/locations/l/' +
          'integrations/ExecuteConnection:execute?triggerId=api_trigger%2F' +
          'ExecuteConnection',
      );
      expect(init.method).toBe('POST');
      expect(init.headers['Authorization']).toBe('Bearer service-token');
      expect(JSON.parse(init.body)).toEqual({
        pageSize: 5,
        connectionName: CONNECTION_DETAILS.name,
        serviceName: CONNECTION_DETAILS.serviceName,
        host: CONNECTION_DETAILS.host,
        entity: 'Issues',
        operation: 'LIST_ENTITIES',
        dynamicAuthConfig: {
          'oauth2_auth_code_flow.access_token': 'user-token',
        },
      });
    });
  });
});

/** Runs `tool` against a stubbed wrapped call and returns the args it sent. */
async function runAndCaptureArgs(
  tool: IntegrationConnectorTool,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const delegated = vi
    .spyOn(RestApiTool.prototype, 'runAsync')
    .mockImplementation(async (request) => {
      captured = request.args;
      return {};
    });

  await tool.runAsync({args: {}, toolContext: createContext()});

  delegated.mockRestore();
  if (!captured) {
    expect.fail('the connector tool delegated to no RestApiTool');
  }
  return captured;
}

/** Returns the credential the toolset configured its generated tools with. */
async function capturedServiceCredential(
  toolset: ApplicationIntegrationToolset,
): Promise<AuthCredential> {
  let captured: AuthCredential | undefined;
  const configure = vi
    .spyOn(RestApiTool.prototype, 'configureAuthCredential')
    .mockImplementation(function (credential: AuthCredential) {
      captured ??= credential;
    });
  await toolset.getTools();
  configure.mockRestore();
  if (!captured) {
    expect.fail('the toolset configured no credential');
  }
  return captured;
}
