/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  IntegrationConnectorTool,
  RestApiTool,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {State} from '../../../src/sessions/state.js';
import {logger} from '../../../src/utils/logger.js';

/** An operation whose body carries both model arguments and injected ones. */
const OPERATION: OpenAPIV3.OperationObject = {
  operationId: 'list_Issues',
  requestBody: {
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: [
            'operation',
            'connectionName',
            'serviceName',
            'host',
            'entity',
            'pageSize',
            'query',
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
            pageToken: {type: 'string'},
            filter: {type: 'string'},
            sortByColumns: {type: 'array', items: {type: 'string'}},
            query: {type: 'string'},
          },
        },
      },
    },
  },
  responses: {},
};

function createRestApiToolStub() {
  const tool = new RestApiTool(
    'list_issues',
    'lists issues',
    {
      baseUrl: 'https://integrations.googleapis.com',
      path: '/x',
      method: 'post',
    },
    OPERATION,
  );
  const runAsync = vi.fn().mockResolvedValue({rows: []});
  tool.runAsync = runAsync;
  return {tool, runAsync};
}

function createTool(
  overrides: {
    authScheme?: OpenAPIV3.SecuritySchemeObject;
    authCredential?: AuthCredential;
    entity?: string;
    action?: string;
    operation?: string;
  } = {},
) {
  const {tool: restApiTool, runAsync} = createRestApiToolStub();
  const connectorTool = new IntegrationConnectorTool({
    name: 'list_issues',
    description: 'lists issues',
    connectionName: 'projects/p/locations/l/connections/c',
    connectionHost: 'my.host.example',
    connectionServiceName: 'tls-directory',
    entity: 'Issues',
    operation: 'LIST_ENTITIES',
    restApiTool,
    ...overrides,
  });
  return {connectorTool, runAsync};
}

function createContext(authResponse?: AuthCredential): Context {
  return {
    state: new State(),
    getAuthResponse: vi.fn().mockReturnValue(authResponse),
    requestCredential: vi.fn(),
  } as unknown as Context;
}

const BEARER_SCHEME: OpenAPIV3.SecuritySchemeObject = {
  type: 'http',
  scheme: 'bearer',
};

describe('IntegrationConnectorTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('_getDeclaration', () => {
    it('hides the arguments the toolset supplies', () => {
      const {connectorTool} = createTool();

      const parameters = connectorTool._getDeclaration().parameters;

      for (const field of [
        'connection_name',
        'service_name',
        'host',
        'entity',
        'operation',
        'action',
        'dynamic_auth_config',
      ]) {
        expect(parameters?.properties).not.toHaveProperty(field);
        expect(parameters?.required).not.toContain(field);
      }
    });

    it('keeps the arguments the model must supply', () => {
      const {connectorTool} = createTool();

      const declaration = connectorTool._getDeclaration();
      const parameters = declaration.parameters;

      expect(Object.keys(parameters?.properties ?? {})).toEqual([
        'page_size',
        'page_token',
        'filter',
        'sort_by_columns',
        'query',
      ]);
      expect(parameters?.required).toEqual(['query']);
      expect(declaration.name).toBe('list_issues');
    });

    it('drops the optional arguments from required but keeps the properties', () => {
      const {connectorTool} = createTool();

      const parameters = connectorTool._getDeclaration().parameters;

      expect(parameters?.properties).toHaveProperty('page_size');
      expect(parameters?.required).not.toContain('page_size');
    });

    it('tolerates an operation whose schema has no required list', () => {
      const restApiTool = new RestApiTool(
        'no_body',
        'no body',
        {baseUrl: 'https://x', path: '/x', method: 'post'},
        {operationId: 'no_body', responses: {}},
      );
      const connectorTool = new IntegrationConnectorTool({
        name: 'no_body',
        description: 'no body',
        connectionName: 'c',
        connectionHost: '',
        connectionServiceName: 's',
        operation: 'EXECUTE_ACTION',
        action: 'CustomAction',
        restApiTool,
      });

      const parameters = connectorTool._getDeclaration().parameters;

      expect(parameters?.properties).toEqual({});
      expect(parameters?.required).toBeUndefined();
    });
  });

  describe('runAsync', () => {
    it('injects the connection context and delegates', async () => {
      const {connectorTool, runAsync} = createTool();
      const toolContext = createContext();

      const result = await connectorTool.runAsync({
        args: {page_size: 10},
        toolContext,
      });

      expect(result).toEqual({rows: []});
      expect(runAsync).toHaveBeenCalledWith({
        args: {
          page_size: 10,
          connection_name: 'projects/p/locations/l/connections/c',
          service_name: 'tls-directory',
          host: 'my.host.example',
          entity: 'Issues',
          operation: 'LIST_ENTITIES',
          action: undefined,
        },
        toolContext,
      });
    });

    it('leaves the caller argument object untouched', async () => {
      const {connectorTool} = createTool();
      const args = {page_size: 10};

      await connectorTool.runAsync({args, toolContext: createContext()});

      expect(args).toEqual({page_size: 10});
    });

    it('sets the action instead of the entity for an action tool', async () => {
      const {connectorTool, runAsync} = createTool({
        entity: undefined,
        action: 'CustomAction',
        operation: 'EXECUTE_ACTION',
      });

      await connectorTool.runAsync({args: {}, toolContext: createContext()});

      expect(runAsync.mock.calls[0][0].args).toMatchObject({
        entity: undefined,
        action: 'CustomAction',
        operation: 'EXECUTE_ACTION',
      });
    });

    it('passes the resolved bearer token as the dynamic auth config', async () => {
      const {connectorTool, runAsync} = createTool({
        authScheme: BEARER_SCHEME,
        authCredential: {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'user-token'}},
        },
      });

      await connectorTool.runAsync({args: {}, toolContext: createContext()});

      expect(runAsync.mock.calls[0][0].args['dynamic_auth_config']).toEqual({
        'oauth2_auth_code_flow.access_token': 'user-token',
      });
    });

    it('treats an empty token string as no token', async () => {
      const {connectorTool, runAsync} = createTool({
        authScheme: BEARER_SCHEME,
        authCredential: {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: ''}},
        },
      });

      await connectorTool.runAsync({args: {}, toolContext: createContext()});

      expect(runAsync.mock.calls[0][0].args['dynamic_auth_config']).toEqual({
        'oauth2_auth_code_flow.access_token': {},
      });
    });

    it('passes an empty token when the resolved credential carries none', async () => {
      const {connectorTool, runAsync} = createTool({
        authScheme: BEARER_SCHEME,
        authCredential: {authType: AuthCredentialTypes.API_KEY, apiKey: 'k'},
      });

      await connectorTool.runAsync({args: {}, toolContext: createContext()});

      expect(runAsync.mock.calls[0][0].args['dynamic_auth_config']).toEqual({
        'oauth2_auth_code_flow.access_token': {},
      });
    });

    it('omits the dynamic auth config when the tool has no scheme', async () => {
      const {connectorTool, runAsync} = createTool();

      await connectorTool.runAsync({args: {}, toolContext: createContext()});

      expect(runAsync.mock.calls[0][0].args).not.toHaveProperty(
        'dynamic_auth_config',
      );
    });

    it('asks for authorization instead of calling when auth is pending', async () => {
      const {connectorTool, runAsync} = createTool({
        authScheme: BEARER_SCHEME,
      });
      const toolContext = createContext();

      const result = await connectorTool.runAsync({args: {}, toolContext});

      expect(result).toEqual({
        pending: true,
        message: 'Needs your authorization to access your data.',
      });
      expect(runAsync).not.toHaveBeenCalled();
      expect(toolContext.requestCredential).toHaveBeenCalled();
    });

    it('never logs the access token', async () => {
      const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      const {connectorTool} = createTool({
        authScheme: BEARER_SCHEME,
        authCredential: {
          authType: AuthCredentialTypes.HTTP,
          http: {scheme: 'bearer', credentials: {token: 'secret-token'}},
        },
      });

      await connectorTool.runAsync({args: {}, toolContext: createContext()});

      expect(debug).toHaveBeenCalledTimes(1);
      const message = String(debug.mock.calls[0][0]);
      expect(message).not.toContain('secret-token');
      expect(message).toContain('dynamic_auth_config');
    });
  });
});
