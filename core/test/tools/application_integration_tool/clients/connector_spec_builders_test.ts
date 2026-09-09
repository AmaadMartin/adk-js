/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApplicationIntegrationError,
  ApplicationIntegrationErrorCode,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';
import {
  actionRequest,
  actionResponse,
  convertJsonSchemaToOpenApiSchema,
  createOperation,
  createOperationRequest,
  deleteOperation,
  deleteOperationRequest,
  executeCustomQueryRequest,
  getActionOperation,
  getConnectorBaseSpec,
  getOperation,
  getOperationRequest,
  listOperation,
  listOperationRequest,
  readConnectorExtension,
  readConnectorOperation,
  updateOperation,
  updateOperationRequest,
} from '../../../../src/tools/application_integration_tool/clients/connector_spec_builders.js';

const RESPONSE_REF = '#/components/schemas/execute-connector_Response';

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
    expect(spec.paths).toEqual({});
  });

  it('declares the google_auth security scheme the operations reference', () => {
    const spec = getConnectorBaseSpec();

    expect(spec.security).toEqual([
      {google_auth: ['https://www.googleapis.com/auth/cloud-platform']},
    ]);
    expect(spec.components.securitySchemes?.['google_auth']).toEqual({
      type: 'oauth2',
      flows: {
        implicit: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
          scopes: {
            'https://www.googleapis.com/auth/cloud-platform':
              'Auth for google cloud services',
          },
        },
      },
    });
  });

  it('declares the shared connector schemas', () => {
    const {schemas} = getConnectorBaseSpec().components;

    expect(schemas['operation']).toMatchObject({
      type: 'string',
      default: 'LIST_ENTITIES',
    });
    expect(schemas['pageSize']).toMatchObject({type: 'integer', default: 50});
    expect(schemas['timeout']).toMatchObject({type: 'integer', default: 120});
    expect(schemas['sortByColumns']).toMatchObject({
      type: 'array',
      items: {type: 'string'},
      default: [],
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

  it('returns an independent spec on every call', () => {
    const first = getConnectorBaseSpec();
    first.paths['/added'] = {
      post: {'x-operation': 'LIST_ENTITIES', responses: {}},
    };

    expect(getConnectorBaseSpec().paths).toEqual({});
  });
});

describe('entity operations', () => {
  it('marks the list operation with its entity and operation', () => {
    const {post} = listOperation('Issues', '{"schema":1}', 'prefix', 'do it');

    expect(post['x-operation']).toBe('LIST_ENTITIES');
    expect(post['x-entity']).toBe('Issues');
    expect(post.operationId).toBe('prefix_list_Issues');
    expect(post.summary).toBe('List Issues');
    expect(post.description).toContain('do it');
    expect(requestRef(post)).toBe('#/components/schemas/list_Issues_Request');
    expect(responseSchema(post)).toEqual({
      description: 'Returns a list of Issues of json schema: {"schema":1}',
      $ref: RESPONSE_REF,
    });
  });

  it('marks the get operation with its entity and operation', () => {
    const {post} = getOperation('Issues', '{"schema":1}', 'prefix', 'do it');

    expect(post['x-operation']).toBe('GET_ENTITY');
    expect(post['x-entity']).toBe('Issues');
    expect(post.operationId).toBe('prefix_get_Issues');
    expect(post.description).toBe('Returns the details of the Issues. do it');
    expect(requestRef(post)).toBe('#/components/schemas/get_Issues_Request');
    expect(responseSchema(post)).toEqual({
      description: 'Returns Issues of json schema: {"schema":1}',
      $ref: RESPONSE_REF,
    });
  });

  it('marks the create operation with its entity and operation', () => {
    const {post} = createOperation('Issues', 'prefix', 'do it');

    expect(post['x-operation']).toBe('CREATE_ENTITY');
    expect(post['x-entity']).toBe('Issues');
    expect(post.operationId).toBe('prefix_create_Issues');
    expect(post.summary).toBe('Creates a new Issues');
    expect(requestRef(post)).toBe('#/components/schemas/create_Issues_Request');
    expect(responseSchema(post)).toEqual({$ref: RESPONSE_REF});
  });

  it('marks the update operation with its entity and operation', () => {
    const {post} = updateOperation('Issues', 'prefix', 'do it');

    expect(post['x-operation']).toBe('UPDATE_ENTITY');
    expect(post.operationId).toBe('prefix_update_Issues');
    expect(post.summary).toBe('Updates the Issues');
    expect(requestRef(post)).toBe('#/components/schemas/update_Issues_Request');
  });

  it('marks the delete operation with its entity and operation', () => {
    const {post} = deleteOperation('Issues', 'prefix', 'do it');

    expect(post['x-operation']).toBe('DELETE_ENTITY');
    expect(post.operationId).toBe('prefix_delete_Issues');
    expect(post.summary).toBe('Delete the Issues');
    expect(requestRef(post)).toBe('#/components/schemas/delete_Issues_Request');
  });
});

describe('entity request schemas', () => {
  it('requires the connector input payload to create', () => {
    expect(createOperationRequest('Issues')).toEqual({
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

  it('requires the entity id to update, and allows a filter', () => {
    const schema = updateOperationRequest('Issues');

    expect(schema.required).toEqual([
      'connectorInputPayload',
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

  it('requires the entity id to get, with no filter', () => {
    const schema = getOperationRequest();

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

  it('allows a filter when deleting', () => {
    expect(deleteOperationRequest().properties?.['filterClause']).toEqual({
      $ref: '#/components/schemas/filterClause',
    });
  });

  it('offers paging and sorting when listing', () => {
    const schema = listOperationRequest();

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
});

describe('action operations', () => {
  it('marks an action with EXECUTE_ACTION', () => {
    const {post} = getActionOperation(
      'CustomAction',
      'EXECUTE_ACTION',
      'CustomAction',
      'prefix',
      'do it',
    );

    expect(post['x-action']).toBe('CustomAction');
    expect(post['x-operation']).toBe('EXECUTE_ACTION');
    expect(post.operationId).toBe('prefix_CustomAction');
    expect(post.description).toBe(
      'Use this tool to execute CustomAction do it',
    );
    expect(requestRef(post)).toBe('#/components/schemas/CustomAction_Request');
    expect(responseSchema(post)).toEqual({
      $ref: '#/components/schemas/CustomAction_Response',
    });
  });

  it('adds query guidance for EXECUTE_QUERY', () => {
    const {post} = getActionOperation(
      'ExecuteCustomQuery',
      'EXECUTE_QUERY',
      'ExecuteCustomQuery',
    );

    expect(post['x-operation']).toBe('EXECUTE_QUERY');
    expect(post.description).toContain('Use pageSize = 50 and timeout = 120');
    expect(post.description).toContain('convert it to SQL query');
  });

  it('describes an action request and response', () => {
    expect(
      actionRequest('CustomAction').properties?.['connectorInputPayload'],
    ).toEqual({
      $ref: '#/components/schemas/connectorInputPayload_CustomAction',
    });
    expect(actionResponse('CustomAction')).toEqual({
      type: 'object',
      properties: {
        connectorOutputPayload: {
          $ref: '#/components/schemas/connectorOutputPayload_CustomAction',
        },
      },
    });
  });

  it('requires a query and a timeout for a custom query', () => {
    expect(executeCustomQueryRequest().required).toEqual([
      'operation',
      'connectionName',
      'serviceName',
      'host',
      'action',
      'query',
      'timeout',
      'pageSize',
    ]);
  });
});

describe('readConnectorExtension', () => {
  it('reads an extension the builders wrote', () => {
    const {post} = listOperation('Issues');

    expect(readConnectorExtension(post, 'x-operation')).toBe('LIST_ENTITIES');
    expect(readConnectorExtension(post, 'x-entity')).toBe('Issues');
    expect(readConnectorExtension(post, 'x-action')).toBeUndefined();
  });

  it('ignores an extension that is not a string', () => {
    const operation: OpenAPIV3.OperationObject = Object.assign(
      {responses: {}},
      {'x-operation': 42},
    );

    expect(readConnectorExtension(operation, 'x-operation')).toBeUndefined();
  });
});

describe('readConnectorOperation', () => {
  it('reads the operation the builders wrote', () => {
    const {post} = listOperation('Issues');

    expect(readConnectorOperation(post, '/some/path')).toBe('LIST_ENTITIES');
  });

  it('rejects an operation that carries no x-operation', () => {
    const operation: OpenAPIV3.OperationObject = {responses: {}};

    let thrown: unknown;
    try {
      readConnectorOperation(operation, '/some/path');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApplicationIntegrationError);
    expect((thrown as ApplicationIntegrationError).code).toBe(
      ApplicationIntegrationErrorCode.INVALID_REQUEST,
    );
    expect((thrown as Error).message).toBe(
      'The operation at /some/path carries no x-operation extension, so it' +
        ' is not an Integration Connectors operation.',
    );
  });
});

describe('convertJsonSchemaToOpenApiSchema', () => {
  it('keeps a plain type and its description', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({
        type: 'string',
        description: 'a name',
      }),
    ).toEqual({type: 'string', description: 'a name'});
  });

  it('turns a nullable union into nullable plus the named type', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({type: ['string', 'null']}),
    ).toEqual({type: 'string', nullable: true});
  });

  it('keeps only the first member of a union of named types', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({type: ['string', 'number']}),
    ).toEqual({type: 'string'});
  });

  it('keeps nullable when null is the only declared type', () => {
    expect(convertJsonSchemaToOpenApiSchema({type: ['null']})).toEqual({
      nullable: true,
    });
  });

  it('returns an empty schema for a schema with no type', () => {
    expect(convertJsonSchemaToOpenApiSchema({})).toEqual({});
  });

  it('converts nested object properties', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({
        type: 'object',
        properties: {
          id: {type: 'integer'},
          owner: {
            type: 'object',
            properties: {name: {type: ['string', 'null']}},
          },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        id: {type: 'integer'},
        owner: {
          type: 'object',
          properties: {name: {type: 'string', nullable: true}},
        },
      },
    });
  });

  it('omits properties that are not objects', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({
        type: 'object',
        properties: {id: 'not a schema'},
      }),
    ).toEqual({type: 'object', properties: {}});
  });

  it('leaves an object with no properties untouched', () => {
    expect(convertJsonSchemaToOpenApiSchema({type: 'object'})).toEqual({
      type: 'object',
    });
  });

  it('converts array items', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({
        type: 'array',
        items: {type: 'string'},
      }),
    ).toEqual({type: 'array', items: {type: 'string'}});
  });

  it('uses the first member of a tuple-form items list', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({
        type: 'array',
        items: [{type: 'integer'}, {type: 'string'}],
      }),
    ).toEqual({type: 'array', items: {type: 'integer'}});
  });

  it('accepts any element when an array declares no items', () => {
    expect(convertJsonSchemaToOpenApiSchema({type: 'array'})).toEqual({
      type: 'array',
      items: {},
    });
  });
});

describe('the connector payload conversion', () => {
  it('converts the entity schema the Connectors API returns', () => {
    expect(
      convertJsonSchemaToOpenApiSchema({
        type: 'object',
        properties: {key: {type: ['string', 'null'], description: 'the key'}},
      }),
    ).toEqual({
      type: 'object',
      properties: {
        key: {type: 'string', nullable: true, description: 'the key'},
      },
    });
  });
});

function requestRef(operation: OpenAPIV3.OperationObject): string | undefined {
  const body = operation.requestBody as OpenAPIV3.RequestBodyObject;
  const schema = body.content['application/json'].schema;
  return schema && '$ref' in schema ? schema.$ref : undefined;
}

function responseSchema(
  operation: OpenAPIV3.OperationObject,
): OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined {
  const response = operation.responses['200'] as OpenAPIV3.ResponseObject;
  return response.content?.['application/json'].schema;
}
