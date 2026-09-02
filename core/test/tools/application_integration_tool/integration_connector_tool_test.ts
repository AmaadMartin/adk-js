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
  FeatureName,
  IntegrationConnectorTool,
  IntegrationConnectorToolOptions,
  InvocationContext,
  PluginManager,
  RestApiTool,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {inspect} from 'node:util';
import {OpenAPIV3} from 'openapi-types';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * The argument schema adk-python's reference test mocks its parser with. The
 * property names are already snake-cased, as `OperationParser` emits them.
 */
const REFERENCE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    user_id: {type: 'string', description: 'User ID'},
    connection_name: {type: 'string'},
    host: {type: 'string'},
    service_name: {type: 'string'},
    entity: {type: 'string'},
    operation: {type: 'string'},
    action: {type: 'string'},
    page_size: {type: 'integer'},
    filter: {type: 'string'},
  },
  required: ['user_id', 'page_size', 'filter', 'connection_name'],
};

/** A schema that marks every connector-defaulted argument required. */
const ALL_OPTIONAL_FIELDS_REQUIRED_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    user_id: {type: 'string'},
    page_size: {type: 'integer'},
    page_token: {type: 'string'},
    filter: {type: 'string'},
    sortByColumns: {type: 'array', items: {type: 'string'}},
  },
  required: ['user_id', 'page_size', 'page_token', 'filter', 'sortByColumns'],
};

/**
 * The request schema of a generated `ExecuteConnection` operation, cut down to
 * the fields these tests read.
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

const EXCLUDED_FIELDS = [
  'connection_name',
  'service_name',
  'host',
  'entity',
  'operation',
  'action',
  'dynamic_auth_config',
];

function createWrappedTool(): RestApiTool {
  // The constructor, not `createRestApiTool`, because the parameters come from
  // the operation here and a caller-supplied list would replace them.
  return new RestApiTool(
    'list_issues',
    'Lists issues.',
    {
      baseUrl: 'https://integrations.googleapis.com',
      path: '/v2/projects/p/locations/l/integrations/ExecuteConnection:execute',
      method: 'post',
    },
    {
      operationId: 'list_issues',
      requestBody: {
        content: {'application/json': {schema: REQUEST_SCHEMA}},
      },
      responses: {},
    },
  );
}

/**
 * A wrapped tool reporting `schema` as its argument schema.
 *
 * `getJsonSchema` is public, so a declaration test pins the exact schema the
 * tool prunes without reaching into the parser. It is also the only way to
 * declare `sortByColumns`, which a real `OperationParser` would snake-case.
 */
function createToolWithSchema(schema: Record<string, unknown>): RestApiTool {
  const restApiTool = createWrappedTool();
  restApiTool.getJsonSchema = vi.fn().mockReturnValue(schema);
  return restApiTool;
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

/** Reads the arguments the delegated call carried on `callIndex`. */
function sentArgs(
  delegated: ReturnType<typeof vi.fn>,
  callIndex: number,
): Record<string, unknown> {
  const [{args}] = delegated.mock.calls[callIndex] as [
    {args: Record<string, unknown>},
  ];
  return args;
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
        authCredential: bearer('user-token'),
      });

      await tool.runAsync({args: {}, toolContext: createContext()});

      expect(sentArgs(delegated, 0)['dynamic_auth_config']).toEqual({
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

      // The connector reads an empty object, not null, as "no token supplied".
      expect(sentArgs(delegated, 0)['dynamic_auth_config']).toEqual({
        'oauth2_auth_code_flow.access_token': {},
      });
    });

    it('adds no dynamic auth config when the tool has no auth scheme', async () => {
      const {tool} = createTool({restApiTool});

      await tool.runAsync({args: {}, toolContext: createContext()});

      expect(sentArgs(delegated, 0)).not.toHaveProperty('dynamic_auth_config');
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
        authCredential: bearer('user-token'),
      });
      const args = {page_size: 10};

      await tool.runAsync({args, toolContext: createContext()});

      // The caller's object is the one recorded on the function-call event, so
      // the access token must never reach it.
      expect(args).toEqual({page_size: 10});
    });

    it('passes a camelCase argument through untouched', async () => {
      const {tool} = createTool({restApiTool});

      await tool.runAsync({
        args: {sortByColumns: ['a', 'b']},
        toolContext: createContext(),
      });

      expect(sentArgs(delegated, 0)['sortByColumns']).toEqual(['a', 'b']);
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
      expect(sentArgs(delegated, 0)['dynamic_auth_config']).toEqual({
        'oauth2_auth_code_flow.access_token': 'exchanged-token',
      });
      expect(sentArgs(delegated, 1)['dynamic_auth_config']).toEqual({
        'oauth2_auth_code_flow.access_token': 'raw-token',
      });
    });

    it('returns itself when it authenticates no end user', () => {
      const {tool} = createTool();

      expect(tool.withAuthCredential(bearer('exchanged-token'))).toBe(tool);
    });
  });

  describe('serialized auth options', () => {
    const SERIALIZED_SCHEME = '{"type":"http","scheme":"bearer"}';
    const SERIALIZED_CREDENTIAL = '{"authType":"http"}';

    let delegated: ReturnType<typeof vi.fn>;
    let restApiTool: RestApiTool;

    beforeEach(() => {
      restApiTool = createWrappedTool();
      delegated = vi.fn().mockResolvedValue({ok: true});
      restApiTool.runAsync = delegated;
    });

    it('constructs with both options in their serialized form', () => {
      const {tool} = createTool({
        restApiTool,
        authScheme: SERIALIZED_SCHEME,
        authCredential: SERIALIZED_CREDENTIAL,
      });

      expect(tool.name).toBe('list_issues');
      // A stored scheme, serialized or not, makes the tool rebindable.
      expect(tool.withAuthCredential(bearer('exchanged-token'))).not.toBe(tool);
    });

    it('rejects a serialized scheme and calls nothing', async () => {
      const {tool} = createTool({restApiTool, authScheme: SERIALIZED_SCHEME});

      await expect(
        tool.runAsync({args: {}, toolContext: createContext()}),
      ).rejects.toThrow(
        "IntegrationConnectorTool 'list_issues' holds authScheme or " +
          'authCredential in its serialized string form, which it cannot ' +
          'authenticate with.',
      );
      // Calling the connector without the scheme would call it unauthenticated.
      expect(delegated).not.toHaveBeenCalled();
    });

    it('rejects a serialized credential and calls nothing', async () => {
      const {tool} = createTool({
        restApiTool,
        authScheme: BEARER_SCHEME,
        authCredential: SERIALIZED_CREDENTIAL,
      });

      await expect(
        tool.runAsync({args: {}, toolContext: createContext()}),
      ).rejects.toThrow(
        "IntegrationConnectorTool 'list_issues' holds authScheme or " +
          'authCredential in its serialized string form, which it cannot ' +
          'authenticate with.',
      );
      expect(delegated).not.toHaveBeenCalled();
    });
  });

  describe('_getDeclaration', () => {
    it('hides the injected fields and frees the connector-defaulted ones', async () => {
      const {tool} = createTool({
        restApiTool: createToolWithSchema(REFERENCE_SCHEMA),
      });

      const declaration = await withTemporaryFeatureOverride(
        FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
        false,
        () => tool._getDeclaration(),
      );

      expect(declaration.name).toBe('list_issues');
      expect(declaration.description).toBe('Lists issues.');
      const {properties = {}, required = []} = declaration.parameters ?? {};
      for (const field of EXCLUDED_FIELDS) {
        expect(properties).not.toHaveProperty(field);
        expect(required).not.toContain(field);
      }
      expect(properties).toHaveProperty('user_id');
      expect(properties).toHaveProperty('page_size');
      expect(properties).toHaveProperty('filter');
      expect(required).toEqual(['user_id']);
    });

    it('declares a raw JSON schema when JSON_SCHEMA_FOR_FUNC_DECL is on', async () => {
      const {tool} = createTool({
        restApiTool: createToolWithSchema(REFERENCE_SCHEMA),
      });

      const declaration = await withTemporaryFeatureOverride(
        FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
        true,
        () => tool._getDeclaration(),
      );

      expect(declaration.parameters).toBeUndefined();
      expect(declaration.parametersJsonSchema).toEqual({
        type: 'object',
        properties: {
          user_id: {type: 'string', description: 'User ID'},
          page_size: {type: 'integer'},
          filter: {type: 'string'},
        },
        required: ['user_id'],
      });
    });

    it('frees every connector-defaulted argument the spec marked required', () => {
      const {tool} = createTool({
        restApiTool: createToolWithSchema(ALL_OPTIONAL_FIELDS_REQUIRED_SCHEMA),
      });

      const {properties = {}, required = []} =
        tool._getDeclaration().parameters ?? {};

      expect(required).toEqual(['user_id']);
      for (const field of [
        'page_size',
        'page_token',
        'filter',
        'sortByColumns',
      ]) {
        expect(properties).toHaveProperty(field);
      }
    });

    it('reads a spec that declares no properties and no required list', () => {
      const {tool} = createTool({
        restApiTool: createToolWithSchema({type: 'object'}),
      });

      const parameters = tool._getDeclaration().parameters;

      expect(parameters?.properties).toEqual({});
      expect(parameters?.required).toEqual([]);
    });

    it('reads a spec whose properties block is null', () => {
      const {tool} = createTool({
        restApiTool: createToolWithSchema({type: 'object', properties: null}),
      });

      expect(tool._getDeclaration().parameters?.properties).toEqual({});
    });

    it('prunes the schema a real wrapped tool reports', () => {
      const {tool} = createTool();

      const {properties = {}, required = []} =
        tool._getDeclaration().parameters ?? {};

      for (const field of EXCLUDED_FIELDS) {
        expect(properties).not.toHaveProperty(field);
        expect(required).not.toContain(field);
      }
      expect(required).not.toContain('page_size');
      // adk-python leaves `timeout` required, and so does this port.
      expect(required).toContain('timeout');
      expect(required).toContain('entity_id');
      expect(properties).toHaveProperty('page_size');
    });
  });

  describe('debug representations', () => {
    it('renders the connection identity for string interpolation', () => {
      const {tool} = createTool({action: 'ExecuteCustomQuery'});

      expect(`${tool}`).toBe(
        'ApplicationIntegrationTool(name="list_issues", ' +
          'description="Lists issues.", ' +
          'connection_name="projects/p/locations/l/connections/jira", ' +
          'entity="Issues", operation="LIST_ENTITIES", ' +
          'action="ExecuteCustomQuery")',
      );
    });

    it('adds the host, the service directory and the wrapped tool for inspect', () => {
      const {tool} = createTool({action: 'ExecuteCustomQuery'});

      const rendered = inspect(tool);

      expect(rendered).toContain('connection_host="jira.example.com"');
      expect(rendered).toContain('connection_service_name="services/jira"');
      expect(rendered).toContain('rest_api_tool="list_issues"');
      expect(rendered).toContain(
        'connection_name="projects/p/locations/l/connections/jira"',
      );
      expect(rendered).toContain('entity="Issues"');
      expect(rendered).toContain('operation="LIST_ENTITIES"');
      expect(rendered).toContain('action="ExecuteCustomQuery"');
    });

    it('renders no credential', () => {
      const {tool} = createTool({
        authScheme: BEARER_SCHEME,
        authCredential: bearer('user-token'),
        credentialKey: 'secret-slot',
      });

      for (const rendered of [`${tool}`, inspect(tool)]) {
        expect(rendered).not.toContain('user-token');
        expect(rendered).not.toContain('secret-slot');
      }
    });
  });
});
