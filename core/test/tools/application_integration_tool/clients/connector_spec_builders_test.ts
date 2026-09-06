/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  actionRequest,
  actionResponse,
  convertJsonSchemaToOpenApiSchema,
  ENTITY_OPERATIONS,
  executeCustomQueryRequest,
  getActionOperation,
  getConnectorBaseSpec,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Resolves an entity operation builder the way `IntegrationClient` does, so
 * these tests drive the surface the package actually uses.
 */
function entityOperation(name: string) {
  const builder = ENTITY_OPERATIONS.get(name);
  if (builder === undefined) {
    expect.fail(`ENTITY_OPERATIONS has no entry for ${name}`);
  }
  return builder;
}

describe('getConnectorBaseSpec', () => {
  it('describes the ExecuteConnection integration', () => {
    const spec = getConnectorBaseSpec();

    expect(spec.openapi).toBe('3.0.1');
    expect(spec.info).toEqual({
      title: 'ExecuteConnection',
      description: 'This tool can execute a query on connection',
      version: '4',
    });
    expect(spec.servers).toEqual([
      {url: 'https://integrations.googleapis.com'},
    ]);
    expect(spec.security).toEqual([{google_auth: [CLOUD_PLATFORM_SCOPE]}]);
    expect(spec.paths).toEqual({});
  });

  it('declares the shared request and response schemas', () => {
    const schemas = getConnectorBaseSpec().components.schemas;

    expect(schemas['operation']).toEqual({
      type: 'string',
      default: 'LIST_ENTITIES',
      description:
        'Operation to execute. Possible values are LIST_ENTITIES, GET_ENTITY,' +
        ' CREATE_ENTITY, UPDATE_ENTITY, DELETE_ENTITY in case of entities.' +
        ' EXECUTE_ACTION in case of actions. and EXECUTE_QUERY in case of' +
        ' custom queries.',
    });
    expect(schemas['pageSize']).toEqual({
      type: 'integer',
      default: 50,
      description: 'Number of entities to return in the response',
    });
    expect(schemas['timeout']).toEqual({
      type: 'integer',
      default: 120,
      description: 'Timeout in seconds for execution of custom query',
    });
    expect(schemas['entity']).toEqual({
      type: 'string',
      default: 'Issues',
      description: 'Entity to run the query for',
    });
    expect(schemas['action']).toEqual({
      type: 'string',
      default: 'ExecuteCustomQuery',
      description: 'Action to run the query for',
    });
    expect(schemas['sortByColumns']).toEqual({
      type: 'array',
      items: {type: 'string'},
      default: [],
      description: 'Column to sort the results by',
    });
    expect(schemas['execute-connector_Response']).toEqual({
      required: ['connectorOutputPayload'],
      type: 'object',
      properties: {
        connectorOutputPayload: {
          $ref: '#/components/schemas/connectorOutputPayload',
        },
        nextPageToken: {$ref: '#/components/schemas/nextPageToken'},
      },
    });
  });

  it('declares the google_auth implicit flow', () => {
    const schemes = getConnectorBaseSpec().components.securitySchemes;

    expect(schemes?.['google_auth']).toEqual({
      type: 'oauth2',
      flows: {
        implicit: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          scopes: {[CLOUD_PLATFORM_SCOPE]: 'Auth for google cloud services'},
        },
      },
    });
  });

  it('returns an independent document on every call', () => {
    const first = getConnectorBaseSpec();
    first.paths['/added'] = {};

    expect(getConnectorBaseSpec().paths).toEqual({});
  });
});

describe('getActionOperation', () => {
  it('describes an action execution', () => {
    const item = getActionOperation(
      'CustomAction',
      'EXECUTE_ACTION',
      'CustomAction',
      'test_tool',
      'do it well',
    );

    expect(item.post).toEqual({
      summary: 'CustomAction',
      description: 'Use this tool to execute CustomAction do it well',
      operationId: 'test_tool_CustomAction',
      'x-action': 'CustomAction',
      'x-operation': 'EXECUTE_ACTION',
      requestBody: {
        content: {
          'application/json': {
            schema: {$ref: '#/components/schemas/CustomAction_Request'},
          },
        },
      },
      responses: {
        '200': {
          description: 'Success response',
          content: {
            'application/json': {
              schema: {$ref: '#/components/schemas/CustomAction_Response'},
            },
          },
        },
      },
    });
  });

  it('appends the custom query guidance for EXECUTE_QUERY', () => {
    const item = getActionOperation(
      'ExecuteCustomQuery',
      'EXECUTE_QUERY',
      'ExecuteCustomQuery',
      'test_tool',
      '',
    );

    expect(item.post?.description).toBe(
      'Use this tool to execute ExecuteCustomQuery Use pageSize = 50 and' +
        ' timeout = 120 until user specifies a different value otherwise. If' +
        ' user provides a query in natural language, convert it to SQL query' +
        ' and then execute it using the tool. ',
    );
  });
});

describe('entity operations', () => {
  it('describes a list operation, keeping the reference wording', () => {
    const item = entityOperation('list').operation({
      entity: 'Issues',
      schemaAsString: '{"type": "object"}',
      toolName: 'test_tool',
      toolInstructions: 'extra',
    });

    expect(item.post?.summary).toBe('List Issues');
    expect(item.post?.operationId).toBe('test_tool_list_Issues');
    expect(item.post?.['x-operation']).toBe('LIST_ENTITIES');
    expect(item.post?.['x-entity']).toBe('Issues');
    expect(item.post?.description).toBe(
      'Returns the list of Issues data. If the page token was available in' +
        ' the response, let users know there are more records available. Ask' +
        ' if the user wants to fetch the next page of results. When passing' +
        ' filter use the\n                following format:' +
        " `field_name1='value1' AND field_name2='value2'\n" +
        '                `. extra',
    );
    expect(item.post?.responses['200']).toEqual({
      description: 'Success response',
      content: {
        'application/json': {
          schema: {
            description:
              'Returns a list of Issues of json schema: {"type": "object"}',
            $ref: '#/components/schemas/execute-connector_Response',
          },
        },
      },
    });
  });

  it('describes a get operation', () => {
    const item = entityOperation('get').operation({
      entity: 'Issues',
      schemaAsString: '{"type": "object"}',
      toolName: 'test_tool',
      toolInstructions: '',
    });

    expect(item.post?.summary).toBe('Get Issues');
    expect(item.post?.operationId).toBe('test_tool_get_Issues');
    expect(item.post?.['x-operation']).toBe('GET_ENTITY');
    expect(item.post?.['x-entity']).toBe('Issues');
    expect(item.post?.description).toBe('Returns the details of the Issues. ');
    expect(item.post?.requestBody).toEqual({
      content: {
        'application/json': {
          schema: {$ref: '#/components/schemas/get_Issues_Request'},
        },
      },
    });
  });

  it('describes a create operation', () => {
    const item = entityOperation('create').operation({
      entity: 'Issues',
      schemaAsString: '',
      toolName: 'test_tool',
      toolInstructions: 'extra',
    });

    expect(item.post?.summary).toBe('Creates a new Issues');
    expect(item.post?.description).toBe('Creates a new Issues. extra');
    expect(item.post?.operationId).toBe('test_tool_create_Issues');
    expect(item.post?.['x-operation']).toBe('CREATE_ENTITY');
    expect(item.post?.['x-entity']).toBe('Issues');
    expect(item.post?.responses['200']).toEqual({
      description: 'Success response',
      content: {
        'application/json': {
          schema: {$ref: '#/components/schemas/execute-connector_Response'},
        },
      },
    });
  });

  it('describes an update operation', () => {
    const item = entityOperation('update').operation({
      entity: 'Issues',
      schemaAsString: '',
      toolName: 'test_tool',
      toolInstructions: '',
    });

    expect(item.post?.summary).toBe('Updates the Issues');
    expect(item.post?.description).toBe('Updates the Issues. ');
    expect(item.post?.operationId).toBe('test_tool_update_Issues');
    expect(item.post?.['x-operation']).toBe('UPDATE_ENTITY');
  });

  it('describes a delete operation', () => {
    const item = entityOperation('delete').operation({
      entity: 'Issues',
      schemaAsString: '',
      toolName: 'test_tool',
      toolInstructions: '',
    });

    expect(item.post?.summary).toBe('Delete the Issues');
    expect(item.post?.description).toBe('Deletes the Issues. ');
    expect(item.post?.operationId).toBe('test_tool_delete_Issues');
    expect(item.post?.['x-operation']).toBe('DELETE_ENTITY');
  });
});

describe('request schemas', () => {
  it('requires the payload and the connection identity to create', () => {
    expect(entityOperation('create').request('Issues')).toEqual({
      type: 'object',
      required: [
        'connectorInputPayload',
        'operation',
        'connectionName',
        'serviceName',
        'host',
        'entity',
      ],
      properties: {
        connectorInputPayload: {
          $ref: '#/components/schemas/connectorInputPayload_Issues',
        },
        operation: {$ref: '#/components/schemas/operation'},
        connectionName: {$ref: '#/components/schemas/connectionName'},
        serviceName: {$ref: '#/components/schemas/serviceName'},
        host: {$ref: '#/components/schemas/host'},
        entity: {$ref: '#/components/schemas/entity'},
        dynamicAuthConfig: {$ref: '#/components/schemas/dynamicAuthConfig'},
      },
    });
  });

  it('adds the entity id and the filter clause to update', () => {
    const schema = entityOperation('update').request('Issues');

    expect(schema.required).toEqual([
      'connectorInputPayload',
      'entityId',
      'operation',
      'connectionName',
      'serviceName',
      'host',
      'entity',
    ]);
    expect(schema.properties?.['entityId']).toEqual({
      $ref: '#/components/schemas/entityId',
    });
    expect(schema.properties?.['filterClause']).toEqual({
      $ref: '#/components/schemas/filterClause',
    });
  });

  it('requires the entity id to get', () => {
    const schema = entityOperation('get').request('Issues');

    expect(schema.required).toEqual([
      'entityId',
      'operation',
      'connectionName',
      'serviceName',
      'host',
      'entity',
    ]);
    expect(schema.properties?.['filterClause']).toBeUndefined();
  });

  it('adds the filter clause to delete', () => {
    const schema = entityOperation('delete').request('Issues');

    expect(schema.required).toEqual([
      'entityId',
      'operation',
      'connectionName',
      'serviceName',
      'host',
      'entity',
    ]);
    expect(schema.properties?.['filterClause']).toEqual({
      $ref: '#/components/schemas/filterClause',
    });
  });

  it('offers paging and sorting to list', () => {
    const schema = entityOperation('list').request('Issues');

    expect(schema.required).toEqual([
      'operation',
      'connectionName',
      'serviceName',
      'host',
      'entity',
    ]);
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'filterClause',
      'pageSize',
      'pageToken',
      'operation',
      'connectionName',
      'serviceName',
      'host',
      'entity',
      'sortByColumns',
      'dynamicAuthConfig',
    ]);
  });

  it('points an action request at its own input payload', () => {
    const schema = actionRequest('CustomAction');

    expect(schema.required).toEqual([
      'operation',
      'connectionName',
      'serviceName',
      'host',
      'action',
      'connectorInputPayload',
    ]);
    expect(schema.properties?.['connectorInputPayload']).toEqual({
      $ref: '#/components/schemas/connectorInputPayload_CustomAction',
    });
  });

  it('points an action response at its own output payload', () => {
    expect(actionResponse('CustomAction')).toEqual({
      type: 'object',
      properties: {
        connectorOutputPayload: {
          $ref: '#/components/schemas/connectorOutputPayload_CustomAction',
        },
      },
    });
  });

  it('requires a query, a timeout and a page size for a custom query', () => {
    const schema = executeCustomQueryRequest();

    expect(schema.required).toEqual([
      'operation',
      'connectionName',
      'serviceName',
      'host',
      'action',
      'query',
      'timeout',
      'pageSize',
    ]);
    expect(schema.properties?.['query']).toEqual({
      $ref: '#/components/schemas/query',
    });
  });
});

describe('convertJsonSchemaToOpenApiSchema', () => {
  it('resolves a nullable union type and keeps the description', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({
        type: 'object',
        properties: {
          input: {type: ['null', 'string'], description: 'description'},
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        input: {type: 'string', nullable: true, description: 'description'},
      },
    });
  });

  it('takes the first entry of a union without null', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({type: ['integer', 'string']}),
    ).toEqual({
      type: 'integer',
    });
  });

  it('marks a type list holding only null as nullable', () => {
    expect(convertJsonSchemaToOpenApiSchema({type: ['null']})).toEqual({
      nullable: true,
    });
  });

  it('recurses into array items', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({
        type: 'array',
        items: {type: 'string'},
      }),
    ).toEqual({
      type: 'array',
      items: {type: 'string'},
    });
  });

  it('leaves a positional items list unconstrained', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({
        type: 'array',
        items: [{type: 'string'}, {type: 'integer'}],
      }),
    ).toEqual({type: 'array', items: {}});
  });

  it('replaces a property schema that is not an object', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({
        type: 'object',
        properties: {input: 'nonsense'},
      }),
    ).toEqual({type: 'object', properties: {input: {}}});
  });

  it('replaces an items schema that is not an object', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({type: 'array', items: 'nonsense'}),
    ).toEqual({
      type: 'array',
      items: {},
    });
  });

  it('drops keywords it does not carry over', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({
        type: 'string',
        maxLength: 10,
        enum: ['a'],
      }),
    ).toEqual({type: 'string'});
  });

  it('returns an empty schema for a schema with no type', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({properties: {a: {type: 'string'}}}),
    ).toEqual({});
  });

  it('ignores items on a non-array type', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({
        type: 'string',
        items: {type: 'string'},
      }),
    ).toEqual({
      type: 'string',
    });
  });

  it('leaves the items of an array schema unconstrained when it lists none', () => {
    expect(convertJsonSchemaToOpenApiSchema({type: 'array'})).toEqual({
      type: 'array',
      items: {},
    });
  });

  it('drops a type OpenAPI 3.0 has no form for', () => {
    expect(convertJsonSchemaToOpenApiSchema({type: 'nonsense'})).toEqual({});
  });

  it('drops a union whose only named type OpenAPI 3.0 cannot express', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({type: ['null', 'nonsense']}),
    ).toEqual({nullable: true});
  });

  it('drops a union whose first entry OpenAPI 3.0 cannot express', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({type: ['nonsense', 'string']}),
    ).toEqual({});
  });

  it('drops a description that is not a string', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({type: 'string', description: 7}),
    ).toEqual({type: 'string'});
  });
});

describe('server url', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Reads the single server URL the base spec declares. */
  function serverUrl(): string | undefined {
    return getConnectorBaseSpec().servers?.[0]?.url;
  }

  it('serves the default host when the environment asks for no mutual TLS', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', undefined);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);

    expect(serverUrl()).toBe('https://integrations.googleapis.com');
  });

  it('serves the mutual-TLS host when the environment asks for it', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');

    expect(serverUrl()).toBe('https://integrations.mtls.googleapis.com');
  });

  it('re-reads the environment on every call', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');
    const first = serverUrl();
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');

    expect(serverUrl()).not.toBe(first);
    expect(serverUrl()).toBe('https://integrations.mtls.googleapis.com');
  });
});
