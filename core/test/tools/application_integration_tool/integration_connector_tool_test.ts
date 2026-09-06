/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  createRestApiTool,
  createSession,
  IntegrationConnectorTool,
  IntegrationConnectorToolOptions,
  InvocationContext,
  PluginManager,
  RestApiTool,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * The request schema of a generated `ExecuteConnection` operation, cut down to
 * the fields these tests read. `OperationParser` snake-cases the property
 * names, so the tool sees `connection_name` and `page_size`.
 */
const REQUEST_SCHEMA: OpenAPIV3.SchemaObject = {
  type: 'object',
  required: [
    'operation',
    'connectionName',
    'serviceName',
    'host',
    'entity',
    'action',
    'dynamicAuthConfig',
    'pageSize',
    'timeout',
    'entityId',
  ],
  properties: {
    operation: {type: 'string'},
    connectionName: {type: 'string'},
    serviceName: {type: 'string'},
    host: {type: 'string'},
    entity: {type: 'string'},
    action: {type: 'string'},
    dynamicAuthConfig: {type: 'object'},
    pageSize: {type: 'integer'},
    timeout: {type: 'integer'},
    entityId: {type: 'string'},
  },
};

const BEARER_SCHEME: OpenAPIV3.SecuritySchemeObject = {
  type: 'http',
  scheme: 'bearer',
};

function createWrappedTool(): RestApiTool {
  return createRestApiTool({
    name: 'list_issues',
    description: 'Lists issues.',
    endpoint: {
      baseUrl: 'https://integrations.googleapis.com',
      path: '/v2/projects/p/locations/l/integrations/ExecuteConnection:execute',
      method: 'post',
    },
    operation: {
      operationId: 'list_issues',
      requestBody: {
        content: {'application/json': {schema: REQUEST_SCHEMA}},
      },
      responses: {},
    },
  });
}

function createTool(overrides: Partial<IntegrationConnectorToolOptions> = {}): {
  tool: IntegrationConnectorTool;
  restApiTool: RestApiTool;
} {
  const restApiTool = overrides.restApiTool ?? createWrappedTool();
  const tool = new IntegrationConnectorTool({
    name: 'list_issues',
    description: 'Lists issues.',
    connectionName: 'projects/p/locations/l/connections/jira',
    connectionHost: 'jira.example.com',
    connectionServiceName: 'services/jira',
    entity: 'Issues',
    operation: 'LIST_ENTITIES',
    restApiTool,
    ...overrides,
  });
  return {tool, restApiTool};
}

function bearer(token: string): AuthCredential {
  return {
    authType: AuthCredentialTypes.HTTP,
    http: {scheme: 'bearer', credentials: {token}},
  };
}

/** Reads the dynamic auth config the delegated call carried on `callIndex`. */
function sentDynamicAuthConfig(
  delegated: ReturnType<typeof vi.fn>,
  callIndex: number,
): unknown {
  const [{args}] = delegated.mock.calls[callIndex] as [
    {args: Record<string, unknown>},
  ];
  return args['dynamic_auth_config'];
}

/** A tool context with empty session state. */
function createContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 'session-1', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
    // A credential request is only meaningful inside a function call.
    functionCallId: 'call-1',
  });
}

describe('IntegrationConnectorTool', () => {
  describe('runAsync', () => {
    let delegated: ReturnType<typeof vi.fn>;
    let restApiTool: RestApiTool;

    beforeEach(() => {
      restApiTool = createWrappedTool();
      delegated = vi.fn().mockResolvedValue({ok: true});
      restApiTool.runAsync = delegated;
    });

    it('injects the connection identity and delegates to the wrapped tool', async () => {
      const {tool} = createTool({restApiTool});
      const toolContext = createContext();

      const result = await tool.runAsync({
        args: {page_size: 10},
        toolContext,
      });

      expect(result).toEqual({ok: true});
      expect(delegated).toHaveBeenCalledWith({
        args: {
          page_size: 10,
          connection_name: 'projects/p/locations/l/connections/jira',
          service_name: 'services/jira',
          host: 'jira.example.com',
          entity: 'Issues',
          operation: 'LIST_ENTITIES',
          action: undefined,
        },
        toolContext,
      });
    });

    it('sends the end-user token as the dynamic auth config', async () => {
      const {tool} = createTool({
        restApiTool,
        authScheme: BEARER_SCHEME,
        authCredential: {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'user-token'}},
        },
      });

      await tool.runAsync({args: {}, toolContext: createContext()});

      const [{args}] = delegated.mock.calls[0] as [
        {args: Record<string, unknown>},
      ];
      expect(args['dynamic_auth_config']).toEqual({
        'oauth2_auth_code_flow.access_token': 'user-token',
      });
    });

    it('sends an empty dynamic auth config when the credential has no token', async () => {
      const {tool} = createTool({
        restApiTool,
        authScheme: BEARER_SCHEME,
        authCredential: {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {username: 'someone'}},
        },
      });

      await tool.runAsync({args: {}, toolContext: createContext()});

      const [{args}] = delegated.mock.calls[0] as [
        {args: Record<string, unknown>},
      ];
      expect(args['dynamic_auth_config']).toEqual({
        'oauth2_auth_code_flow.access_token': {},
      });
    });

    it('adds no dynamic auth config when the tool has no auth scheme', async () => {
      const {tool} = createTool({restApiTool});

      await tool.runAsync({args: {}, toolContext: createContext()});

      const [{args}] = delegated.mock.calls[0] as [
        {args: Record<string, unknown>},
      ];
      expect(args).not.toHaveProperty('dynamic_auth_config');
    });

    it('returns the pending result and calls nothing while auth is pending', async () => {
      // A scheme with no credential: the handler asks the client for one.
      const {tool} = createTool({
        restApiTool,
        authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: createContext(),
      });

      expect(result).toEqual({
        pending: true,
        message: 'Needs your authorization to access your data.',
      });
      expect(delegated).not.toHaveBeenCalled();
    });

    it('leaves the args the caller passed unchanged', async () => {
      const {tool} = createTool({
        restApiTool,
        authScheme: BEARER_SCHEME,
        authCredential: {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'user-token'}},
        },
      });
      const args = {page_size: 10};

      await tool.runAsync({args, toolContext: createContext()});

      // The caller's object is the one recorded on the function-call event, so
      // the access token must never reach it.
      expect(args).toEqual({page_size: 10});
    });
  });

  describe('withAuthCredential', () => {
    it('copies the tool and replaces only the credential', async () => {
      const restApiTool = createWrappedTool();
      const delegated = vi.fn().mockResolvedValue({ok: true});
      restApiTool.runAsync = delegated;
      const {tool} = createTool({
        restApiTool,
        authScheme: BEARER_SCHEME,
        authCredential: bearer('raw-token'),
      });

      const copy = tool.withAuthCredential(bearer('exchanged-token'));

      expect(copy).not.toBe(tool);
      expect(copy.name).toBe(tool.name);
      expect(copy.description).toBe(tool.description);
      await copy.runAsync({args: {}, toolContext: createContext()});
      await tool.runAsync({args: {}, toolContext: createContext()});
      expect(sentDynamicAuthConfig(delegated, 0)).toEqual({
        'oauth2_auth_code_flow.access_token': 'exchanged-token',
      });
      expect(sentDynamicAuthConfig(delegated, 1)).toEqual({
        'oauth2_auth_code_flow.access_token': 'raw-token',
      });
    });

    it('returns itself when it authenticates no end user', () => {
      const {tool} = createTool();

      expect(tool.withAuthCredential(bearer('exchanged-token'))).toBe(tool);
    });
  });

  describe('_getDeclaration', () => {
    it('hides the injected fields and keeps timeout required', () => {
      const {tool} = createTool();

      const declaration = tool._getDeclaration();

      const {properties = {}, required = []} = declaration.parameters ?? {};
      for (const field of [
        'connection_name',
        'service_name',
        'host',
        'entity',
        'operation',
        'action',
        'dynamic_auth_config',
      ]) {
        expect(properties).not.toHaveProperty(field);
        expect(required).not.toContain(field);
      }
      expect(required).not.toContain('page_size');
      // adk-python leaves `timeout` required, and so does this port.
      expect(required).toContain('timeout');
      expect(required).toContain('entity_id');
      expect(properties).toHaveProperty('page_size');
    });

    it('keeps a schema that declares no required fields intact', () => {
      const restApiTool = createRestApiTool({
        name: 'ping',
        description: 'Pings.',
        endpoint: {
          baseUrl: 'https://example.com',
          path: '/ping',
          method: 'get',
        },
        operation: {operationId: 'ping', responses: {}},
      });
      const {tool} = createTool({restApiTool});

      const parameters = tool._getDeclaration().parameters;

      expect(parameters?.properties).toEqual({});
      expect(parameters?.required).toBeUndefined();
    });
  });
});
