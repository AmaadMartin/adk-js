/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  createSession,
  InMemorySessionService,
  IntegrationConnectorTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RestApiTool,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';

const OPERATION: OpenAPIV3.OperationObject = {
  operationId: 'list_issues',
  requestBody: {
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: [
            'userId',
            'pageSize',
            'filterClause',
            'sortByColumns',
            'connectionName',
          ],
          properties: {
            userId: {type: 'string'},
            pageSize: {type: 'integer'},
            filterClause: {type: 'string'},
            sortByColumns: {type: 'array', items: {type: 'string'}},
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
  },
  responses: {},
};

/**
 * The fixture from adk-python `test_integration_connector_tool.py`. It names a
 * required argument `filter`, which the generated connector spec never does, so
 * it is the only shape that tells the two `OPTIONAL_FIELDS` lists apart.
 */
const PYTHON_FIXTURE_OPERATION: OpenAPIV3.OperationObject = {
  operationId: 'list_issues',
  requestBody: {
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['userId', 'pageSize', 'filter', 'connectionName'],
          properties: {
            userId: {type: 'string'},
            connectionName: {type: 'string'},
            host: {type: 'string'},
            serviceName: {type: 'string'},
            entity: {type: 'string'},
            operation: {type: 'string'},
            action: {type: 'string'},
            pageSize: {type: 'integer'},
            filter: {type: 'string'},
          },
        },
      },
    },
  },
  responses: {},
};

const BEARER_SCHEME: OpenAPIV3.HttpSecurityScheme = {
  type: 'http',
  scheme: 'bearer',
};

function createRestTool(): RestApiTool {
  return new RestApiTool(
    'list_issues',
    'Lists the issues',
    {
      baseUrl: 'https://integrations.googleapis.com',
      path: '/v2',
      method: 'post',
    },
    OPERATION,
  );
}

function createTool(
  overrides: {
    authScheme?: OpenAPIV3.SecuritySchemeObject;
    authCredential?: AuthCredential;
    restApiTool?: RestApiTool;
    entity?: string;
    action?: string;
    operation?: string;
  } = {},
): IntegrationConnectorTool {
  return new IntegrationConnectorTool({
    name: 'list_issues',
    description: 'Lists the issues',
    connectionName: 'projects/p/locations/l/connections/c',
    connectionHost: 'test.host.com',
    connectionServiceName: 'service-directory',
    entity: 'Issues',
    operation: 'LIST_ENTITIES',
    restApiTool: overrides.restApiTool ?? createRestTool(),
    ...overrides,
  });
}

function createContext(): Context {
  const agent = new LlmAgent({name: 'test_agent', model: 'gemini-2.0-flash'});
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent,
      session: createSession({
        id: 'session',
        appName: 'app',
        userId: 'user',
      }),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
    }),
    functionCallId: 'function-call-1',
  });
}

describe('IntegrationConnectorTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('_getDeclaration', () => {
    it('hides the fields the tool supplies itself', () => {
      const declaration = createTool()._getDeclaration();

      const properties = declaration?.parameters?.properties ?? {};
      expect(Object.keys(properties)).toEqual([
        'user_id',
        'page_size',
        'filter_clause',
        'sort_by_columns',
      ]);
      expect(declaration?.name).toBe('list_issues');
      expect(declaration?.description).toBe('Lists the issues');
    });

    it('keeps only the required fields the model must supply', () => {
      const declaration = createTool()._getDeclaration();

      expect(declaration?.parameters?.required).toEqual([
        'user_id',
        'filter_clause',
        'sort_by_columns',
      ]);
    });

    it('drops a required argument named exactly like an optional field', () => {
      const restApiTool = new RestApiTool(
        'list_issues',
        'Lists the issues',
        {
          baseUrl: 'https://integrations.googleapis.com',
          path: '/v2',
          method: 'post',
        },
        PYTHON_FIXTURE_OPERATION,
      );

      const declaration = createTool({restApiTool})._getDeclaration();

      expect(declaration?.parameters?.required).toEqual(['user_id']);
      expect(Object.keys(declaration?.parameters?.properties ?? {})).toEqual([
        'user_id',
        'page_size',
        'filter',
      ]);
    });

    it('leaves the underlying tool declaration untouched', () => {
      const restApiTool = createRestTool();
      createTool({restApiTool})._getDeclaration();

      expect(
        Object.keys(restApiTool._getDeclaration().parameters?.properties ?? {}),
      ).toContain('connection_name');
    });
  });

  describe('runAsync', () => {
    it('adds the connection identity and delegates', async () => {
      const restApiTool = createRestTool();
      const delegate = vi
        .spyOn(restApiTool, 'runAsync')
        .mockResolvedValue({ok: true});
      const toolContext = createContext();

      const result = await createTool({restApiTool}).runAsync({
        args: {user_id: 'u1'},
        toolContext,
      });

      expect(result).toEqual({ok: true});
      expect(delegate).toHaveBeenCalledWith({
        args: {
          user_id: 'u1',
          connection_name: 'projects/p/locations/l/connections/c',
          service_name: 'service-directory',
          host: 'test.host.com',
          entity: 'Issues',
          operation: 'LIST_ENTITIES',
          action: undefined,
        },
        toolContext,
      });
    });

    it('overwrites a connection identity the model supplied', async () => {
      const restApiTool = createRestTool();
      const delegate = vi
        .spyOn(restApiTool, 'runAsync')
        .mockResolvedValue({ok: true});

      await createTool({restApiTool}).runAsync({
        args: {
          user_id: 'u1',
          connection_name: 'projects/evil/locations/l/connections/attacker',
          service_name: 'attacker-directory',
          host: 'attacker.example.com',
          entity: 'Secrets',
          operation: 'DELETE_ENTITY',
          action: 'ExfiltrateEverything',
        },
        toolContext: createContext(),
      });

      expect(delegate).toHaveBeenCalledWith(
        expect.objectContaining({
          args: {
            user_id: 'u1',
            connection_name: 'projects/p/locations/l/connections/c',
            service_name: 'service-directory',
            host: 'test.host.com',
            entity: 'Issues',
            operation: 'LIST_ENTITIES',
            action: undefined,
          },
        }),
      );
    });

    it('passes the end-user access token as the dynamic auth config', async () => {
      const restApiTool = createRestTool();
      const delegate = vi.spyOn(restApiTool, 'runAsync').mockResolvedValue({});
      const authCredential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'mocked_token'}},
      };

      await createTool({
        restApiTool,
        authScheme: BEARER_SCHEME,
        authCredential,
      }).runAsync({args: {}, toolContext: createContext()});

      expect(delegate.mock.calls[0][0].args['dynamic_auth_config']).toEqual({
        'oauth2_auth_code_flow.access_token': 'mocked_token',
      });
    });

    it('keeps the end-user access token out of the caller args', async () => {
      const restApiTool = createRestTool();
      vi.spyOn(restApiTool, 'runAsync').mockResolvedValue({});
      const authCredential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'mocked_token'}},
      };
      // The session stores this object on the function-call event, so a token
      // written into it reaches the next model turn and the telemetry span.
      const callerArgs: Record<string, unknown> = {user_id: 'u1'};

      await createTool({
        restApiTool,
        authScheme: BEARER_SCHEME,
        authCredential,
      }).runAsync({args: callerArgs, toolContext: createContext()});

      expect(callerArgs).toEqual({user_id: 'u1'});
    });

    it('keeps the connection identity out of the caller args', async () => {
      const restApiTool = createRestTool();
      vi.spyOn(restApiTool, 'runAsync').mockResolvedValue({});
      const callerArgs: Record<string, unknown> = {user_id: 'u1'};

      await createTool({restApiTool}).runAsync({
        args: callerArgs,
        toolContext: createContext(),
      });

      expect(callerArgs).toEqual({user_id: 'u1'});
    });

    it('passes an empty object when the credential carries no token', async () => {
      const restApiTool = createRestTool();
      const delegate = vi.spyOn(restApiTool, 'runAsync').mockResolvedValue({});
      const authCredential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {}},
      };

      await createTool({
        restApiTool,
        authScheme: BEARER_SCHEME,
        authCredential,
      }).runAsync({args: {}, toolContext: createContext()});

      expect(delegate.mock.calls[0][0].args['dynamic_auth_config']).toEqual({
        'oauth2_auth_code_flow.access_token': {},
      });
    });

    it('omits the dynamic auth config when no credential is configured', async () => {
      const restApiTool = createRestTool();
      const delegate = vi.spyOn(restApiTool, 'runAsync').mockResolvedValue({});

      await createTool({restApiTool}).runAsync({
        args: {},
        toolContext: createContext(),
      });

      expect(delegate.mock.calls[0][0].args).not.toHaveProperty(
        'dynamic_auth_config',
      );
    });

    it('asks for authorization instead of calling the connection', async () => {
      const restApiTool = createRestTool();
      const delegate = vi.spyOn(restApiTool, 'runAsync');
      const apiKeyScheme: OpenAPIV3.ApiKeySecurityScheme = {
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
      };

      const result = await createTool({
        restApiTool,
        authScheme: apiKeyScheme,
      }).runAsync({args: {}, toolContext: createContext()});

      expect(result).toEqual({
        pending: true,
        message: 'Needs your authorization to access your data.',
      });
      expect(delegate).not.toHaveBeenCalled();
    });

    it('sets the action instead of the entity for an action tool', async () => {
      const restApiTool = createRestTool();
      const delegate = vi.spyOn(restApiTool, 'runAsync').mockResolvedValue({});

      await createTool({
        restApiTool,
        entity: undefined,
        action: 'CustomAction',
        operation: 'EXECUTE_ACTION',
      }).runAsync({args: {}, toolContext: createContext()});

      expect(delegate.mock.calls[0][0].args).toMatchObject({
        entity: undefined,
        action: 'CustomAction',
        operation: 'EXECUTE_ACTION',
      });
    });
  });

  describe('end-user auth', () => {
    it('asks for authorization when the credential is not yet exchanged', async () => {
      const restApiTool = createRestTool();
      const delegate = vi.spyOn(restApiTool, 'runAsync').mockResolvedValue({});
      const tool = createTool({restApiTool, authScheme: BEARER_SCHEME});

      const result = await tool.runAsync({
        args: {},
        toolContext: createContext(),
      });

      expect(result).toEqual({
        pending: true,
        message: 'Needs your authorization to access your data.',
      });
      expect(delegate).not.toHaveBeenCalled();
    });
  });
});
