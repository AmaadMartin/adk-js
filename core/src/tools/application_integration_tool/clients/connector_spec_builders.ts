/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {isRecord} from '../../../utils/type_guards.js';
import {CLOUD_PLATFORM_SCOPE} from '../constants.js';
import {
  ApplicationIntegrationError,
  ApplicationIntegrationErrorCode,
} from '../errors.js';

/**
 * The Integrations endpoint the generated spec targets.
 *
 * This is the global host, not the regional one the spec generator uses: the
 * `ExecuteConnection` integration is addressed by its full resource path.
 */
const INTEGRATIONS_ENDPOINT = 'https://integrations.googleapis.com';

const EXECUTE_CONNECTOR_RESPONSE_REF =
  '#/components/schemas/execute-connector_Response';

/** Every `type` an OpenAPI 3.0 schema can declare. */
type SchemaObjectType =
  | OpenAPIV3.ArraySchemaObjectType
  | OpenAPIV3.NonArraySchemaObjectType;

/**
 * An operation carrying the connector extensions the toolset reads back.
 *
 * `openapi-types` models only the standard fields, so the extensions are
 * declared here rather than cast away at each write site.
 */
export interface ConnectorOperationObject extends OpenAPIV3.OperationObject {
  'x-operation': string;
  'x-entity'?: string;
  'x-action'?: string;
}

/** A single-operation path item, as the connector spec always emits `post`. */
export interface ConnectorPathItemObject {
  post: ConnectorOperationObject;
}

/**
 * A generated connector spec.
 *
 * Narrower than `OpenAPIV3.Document`: `paths` and `components.schemas` are
 * always present, because the builders below create them.
 */
export interface ConnectorSpecDocument extends OpenAPIV3.Document {
  paths: Record<string, ConnectorPathItemObject>;
  components: OpenAPIV3.ComponentsObject & {
    schemas: Record<string, OpenAPIV3.SchemaObject>;
  };
}

/**
 * Reads a connector extension off a parsed operation.
 *
 * @returns The extension value, or undefined when the operation does not carry
 *     it.
 */
export function readConnectorExtension(
  operation: OpenAPIV3.OperationObject,
  key: 'x-operation' | 'x-entity' | 'x-action',
): string | undefined {
  const value = (operation as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads the connector operation an entry of the generated spec runs.
 *
 * Every operation the builders emit carries `x-operation`. One that does not
 * is not a connector operation, and a tool built from it would post
 * `operation: undefined` and fail at the connector with no explanation.
 *
 * @throws {ApplicationIntegrationError} With code `INVALID_REQUEST` when the
 *     operation carries no `x-operation`.
 */
export function readConnectorOperation(
  operation: OpenAPIV3.OperationObject,
  path: string,
): string {
  const value = readConnectorExtension(operation, 'x-operation');
  if (!value) {
    throw new ApplicationIntegrationError(
      ApplicationIntegrationErrorCode.INVALID_REQUEST,
      `The operation at ${path} carries no x-operation extension, so it is` +
        ' not an Integration Connectors operation.',
    );
  }
  return value;
}

/** The shared skeleton every generated connector spec starts from. */
export function getConnectorBaseSpec(): ConnectorSpecDocument {
  return {
    openapi: '3.0.1',
    info: {
      title: 'ExecuteConnection',
      description: 'This tool can execute a query on connection',
      version: '4',
    },
    servers: [{url: INTEGRATIONS_ENDPOINT}],
    security: [{google_auth: [CLOUD_PLATFORM_SCOPE]}],
    paths: {},
    components: {
      schemas: {
        operation: {
          type: 'string',
          default: 'LIST_ENTITIES',
          description:
            'Operation to execute. Possible values are LIST_ENTITIES,' +
            ' GET_ENTITY, CREATE_ENTITY, UPDATE_ENTITY, DELETE_ENTITY in case' +
            ' of entities. EXECUTE_ACTION in case of actions. and' +
            ' EXECUTE_QUERY in case of custom queries.',
        },
        entityId: {type: 'string', description: 'Name of the entity'},
        connectorInputPayload: {type: 'object'},
        filterClause: {
          type: 'string',
          default: '',
          description: 'WHERE clause in SQL query',
        },
        pageSize: {
          type: 'integer',
          default: 50,
          description: 'Number of entities to return in the response',
        },
        pageToken: {
          type: 'string',
          default: '',
          description: 'Page token to return the next page of entities',
        },
        connectionName: {
          type: 'string',
          default: '',
          description: 'Connection resource name to run the query for',
        },
        serviceName: {
          type: 'string',
          default: '',
          description: 'Service directory for the connection',
        },
        host: {
          type: 'string',
          default: '',
          description: 'Host name in case of tls service directory',
        },
        entity: {
          type: 'string',
          default: 'Issues',
          description: 'Entity to run the query for',
        },
        action: {
          type: 'string',
          default: 'ExecuteCustomQuery',
          description: 'Action to run the query for',
        },
        query: {
          type: 'string',
          default: '',
          description: 'Custom Query to execute on the connection',
        },
        dynamicAuthConfig: {
          type: 'object',
          default: {},
          description: 'Dynamic auth config for the connection',
        },
        timeout: {
          type: 'integer',
          default: 120,
          description: 'Timeout in seconds for execution of custom query',
        },
        sortByColumns: {
          type: 'array',
          items: {type: 'string'},
          default: [],
          description: 'Column to sort the results by',
        },
        connectorOutputPayload: {type: 'object'},
        nextPageToken: {type: 'string'},
        'execute-connector_Response': {
          required: ['connectorOutputPayload'],
          type: 'object',
          properties: {
            connectorOutputPayload: {
              $ref: '#/components/schemas/connectorOutputPayload',
            },
            nextPageToken: {$ref: '#/components/schemas/nextPageToken'},
          },
        },
      },
      securitySchemes: {
        google_auth: {
          type: 'oauth2',
          flows: {
            implicit: {
              authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
              scopes: {
                [CLOUD_PLATFORM_SCOPE]: 'Auth for google cloud services',
              },
            },
          },
        },
      },
    },
  };
}

/** The path item that runs a connector action. */
export function getActionOperation(
  action: string,
  operation: string,
  actionDisplayName: string,
  toolName = '',
  toolInstructions = '',
): ConnectorPathItemObject {
  let description = `Use this tool to execute ${action}`;
  if (operation === 'EXECUTE_QUERY') {
    description +=
      ' Use pageSize = 50 and timeout = 120 until user specifies a different' +
      ' value otherwise. If user provides a query in natural language,' +
      ' convert it to SQL query and then execute it using the tool.';
  }
  return {
    post: {
      summary: actionDisplayName,
      description: `${description} ${toolInstructions}`,
      operationId: `${toolName}_${actionDisplayName}`,
      'x-action': action,
      'x-operation': operation,
      requestBody: jsonRequestBody(
        `#/components/schemas/${actionDisplayName}_Request`,
      ),
      responses: successResponse({
        $ref: `#/components/schemas/${actionDisplayName}_Response`,
      }),
    },
  };
}

/** The path item that lists an entity. */
export function listOperation(
  entity: string,
  schemaAsString = '',
  toolName = '',
  toolInstructions = '',
): ConnectorPathItemObject {
  return {
    post: {
      summary: `List ${entity}`,
      description: `Returns the list of ${entity} data. If the page token was available in the response, let users know there are more records available. Ask if the user wants to fetch the next page of results. When passing filter use the
                following format: \`field_name1='value1' AND field_name2='value2'
                \`. ${toolInstructions}`,
      'x-operation': 'LIST_ENTITIES',
      'x-entity': entity,
      operationId: `${toolName}_list_${entity}`,
      requestBody: jsonRequestBody(
        `#/components/schemas/list_${entity}_Request`,
      ),
      responses: successResponse({
        description: `Returns a list of ${entity} of json schema: ${schemaAsString}`,
        $ref: EXECUTE_CONNECTOR_RESPONSE_REF,
      }),
    },
  };
}

/** The path item that reads one entity record. */
export function getOperation(
  entity: string,
  schemaAsString = '',
  toolName = '',
  toolInstructions = '',
): ConnectorPathItemObject {
  return {
    post: {
      summary: `Get ${entity}`,
      description: `Returns the details of the ${entity}. ${toolInstructions}`,
      operationId: `${toolName}_get_${entity}`,
      'x-operation': 'GET_ENTITY',
      'x-entity': entity,
      requestBody: jsonRequestBody(
        `#/components/schemas/get_${entity}_Request`,
      ),
      responses: successResponse({
        description: `Returns ${entity} of json schema: ${schemaAsString}`,
        $ref: EXECUTE_CONNECTOR_RESPONSE_REF,
      }),
    },
  };
}

/** The path item that creates an entity record. */
export function createOperation(
  entity: string,
  toolName = '',
  toolInstructions = '',
): ConnectorPathItemObject {
  return {
    post: {
      summary: `Creates a new ${entity}`,
      description: `Creates a new ${entity}. ${toolInstructions}`,
      'x-operation': 'CREATE_ENTITY',
      'x-entity': entity,
      operationId: `${toolName}_create_${entity}`,
      requestBody: jsonRequestBody(
        `#/components/schemas/create_${entity}_Request`,
      ),
      responses: successResponse({$ref: EXECUTE_CONNECTOR_RESPONSE_REF}),
    },
  };
}

/** The path item that updates an entity record. */
export function updateOperation(
  entity: string,
  toolName = '',
  toolInstructions = '',
): ConnectorPathItemObject {
  return {
    post: {
      summary: `Updates the ${entity}`,
      description: `Updates the ${entity}. ${toolInstructions}`,
      'x-operation': 'UPDATE_ENTITY',
      'x-entity': entity,
      operationId: `${toolName}_update_${entity}`,
      requestBody: jsonRequestBody(
        `#/components/schemas/update_${entity}_Request`,
      ),
      responses: successResponse({$ref: EXECUTE_CONNECTOR_RESPONSE_REF}),
    },
  };
}

/** The path item that deletes an entity record. */
export function deleteOperation(
  entity: string,
  toolName = '',
  toolInstructions = '',
): ConnectorPathItemObject {
  return {
    post: {
      summary: `Delete the ${entity}`,
      description: `Deletes the ${entity}. ${toolInstructions}`,
      'x-operation': 'DELETE_ENTITY',
      'x-entity': entity,
      operationId: `${toolName}_delete_${entity}`,
      requestBody: jsonRequestBody(
        `#/components/schemas/delete_${entity}_Request`,
      ),
      responses: successResponse({$ref: EXECUTE_CONNECTOR_RESPONSE_REF}),
    },
  };
}

/** The request schema for the create operation. */
export function createOperationRequest(entity: string): OpenAPIV3.SchemaObject {
  return {
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
        $ref: `#/components/schemas/connectorInputPayload_${entity}`,
      },
      ...CONNECTION_PROPERTIES,
      entity: {$ref: '#/components/schemas/entity'},
      dynamicAuthConfig: {$ref: '#/components/schemas/dynamicAuthConfig'},
    },
  };
}

/** The request schema for the update operation. */
export function updateOperationRequest(entity: string): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    required: [
      'connectorInputPayload',
      'entityId',
      'operation',
      'connectionName',
      'serviceName',
      'host',
      'entity',
    ],
    properties: {
      connectorInputPayload: {
        $ref: `#/components/schemas/connectorInputPayload_${entity}`,
      },
      entityId: {$ref: '#/components/schemas/entityId'},
      ...CONNECTION_PROPERTIES,
      entity: {$ref: '#/components/schemas/entity'},
      dynamicAuthConfig: {$ref: '#/components/schemas/dynamicAuthConfig'},
      filterClause: {$ref: '#/components/schemas/filterClause'},
    },
  };
}

/** The request schema for the get operation. */
export function getOperationRequest(): OpenAPIV3.SchemaObject {
  return entityIdRequest({filterClause: false});
}

/** The request schema for the delete operation. */
export function deleteOperationRequest(): OpenAPIV3.SchemaObject {
  return entityIdRequest({filterClause: true});
}

/**
 * The request schema shared by the operations that address one record by id.
 *
 * @param options.filterClause Whether the operation narrows the record set.
 */
function entityIdRequest(options: {
  filterClause: boolean;
}): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    required: [
      'entityId',
      'operation',
      'connectionName',
      'serviceName',
      'host',
      'entity',
    ],
    properties: {
      entityId: {$ref: '#/components/schemas/entityId'},
      ...CONNECTION_PROPERTIES,
      entity: {$ref: '#/components/schemas/entity'},
      dynamicAuthConfig: {$ref: '#/components/schemas/dynamicAuthConfig'},
      ...(options.filterClause
        ? {filterClause: {$ref: '#/components/schemas/filterClause'}}
        : {}),
    },
  };
}

/** The request schema for the list operation. */
export function listOperationRequest(): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    required: ['operation', 'connectionName', 'serviceName', 'host', 'entity'],
    properties: {
      filterClause: {$ref: '#/components/schemas/filterClause'},
      pageSize: {$ref: '#/components/schemas/pageSize'},
      pageToken: {$ref: '#/components/schemas/pageToken'},
      ...CONNECTION_PROPERTIES,
      entity: {$ref: '#/components/schemas/entity'},
      sortByColumns: {$ref: '#/components/schemas/sortByColumns'},
      dynamicAuthConfig: {$ref: '#/components/schemas/dynamicAuthConfig'},
    },
  };
}

/** The request schema for a connector action. */
export function actionRequest(action: string): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    required: [
      'operation',
      'connectionName',
      'serviceName',
      'host',
      'action',
      'connectorInputPayload',
    ],
    properties: {
      ...CONNECTION_PROPERTIES,
      action: {$ref: '#/components/schemas/action'},
      connectorInputPayload: {
        $ref: `#/components/schemas/connectorInputPayload_${action}`,
      },
      dynamicAuthConfig: {$ref: '#/components/schemas/dynamicAuthConfig'},
    },
  };
}

/** The response schema for a connector action. */
export function actionResponse(action: string): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    properties: {
      connectorOutputPayload: {
        $ref: `#/components/schemas/connectorOutputPayload_${action}`,
      },
    },
  };
}

/** The request schema for the built-in custom query action. */
export function executeCustomQueryRequest(): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    required: [
      'operation',
      'connectionName',
      'serviceName',
      'host',
      'action',
      'query',
      'timeout',
      'pageSize',
    ],
    properties: {
      ...CONNECTION_PROPERTIES,
      action: {$ref: '#/components/schemas/action'},
      query: {$ref: '#/components/schemas/query'},
      timeout: {$ref: '#/components/schemas/timeout'},
      pageSize: {$ref: '#/components/schemas/pageSize'},
      dynamicAuthConfig: {$ref: '#/components/schemas/dynamicAuthConfig'},
    },
  };
}

/**
 * Converts a JSON schema to an OpenAPI 3.0 schema.
 *
 * The two differ on nullability and on multi-valued `type`: OpenAPI 3.0 allows
 * one type plus a `nullable` flag, so a union keeps its first non-null member.
 */
export function convertJsonSchemaToOpenApiSchema(
  jsonSchema: Record<string, unknown>,
): OpenAPIV3.SchemaObject {
  const {type, nullable} = readSchemaType(jsonSchema['type']);

  const base: OpenAPIV3.BaseSchemaObject = {};
  if (typeof jsonSchema['description'] === 'string') {
    base.description = jsonSchema['description'];
  }
  if (nullable) {
    base.nullable = true;
  }

  if (type === 'array') {
    return {...base, type, items: readArrayItems(jsonSchema['items'])};
  }

  const properties = jsonSchema['properties'];
  if (type === 'object' && isRecord(properties)) {
    return {...base, type, properties: readProperties(properties)};
  }

  return type === undefined ? base : {...base, type};
}

/**
 * Property refs shared by every connector request schema, in the order the
 * generated spec emits them.
 */
const CONNECTION_PROPERTIES: Record<string, OpenAPIV3.ReferenceObject> = {
  operation: {$ref: '#/components/schemas/operation'},
  connectionName: {$ref: '#/components/schemas/connectionName'},
  serviceName: {$ref: '#/components/schemas/serviceName'},
  host: {$ref: '#/components/schemas/host'},
};

function jsonRequestBody(ref: string): OpenAPIV3.RequestBodyObject {
  return {content: {'application/json': {schema: {$ref: ref}}}};
}

function successResponse(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
): OpenAPIV3.ResponsesObject {
  return {
    '200': {
      description: 'Success response',
      content: {'application/json': {schema}},
    },
  };
}

/**
 * Splits a JSON schema `type` into the single type OpenAPI 3.0 allows and a
 * nullable flag.
 */
function readSchemaType(declared: unknown): {
  type?: SchemaObjectType;
  nullable: boolean;
} {
  const members = Array.isArray(declared) ? declared : [declared];
  const named = members.find(
    (entry): entry is SchemaObjectType =>
      typeof entry === 'string' && entry !== 'null',
  );
  return {type: named, nullable: members.includes('null')};
}

/**
 * Converts the `items` of an array schema.
 *
 * A JSON schema may give `items` as a tuple. OpenAPI 3.0 has no tuple form, so
 * the schema of the first member describes every element. An array that
 * declares no items accepts any element.
 */
function readArrayItems(items: unknown): OpenAPIV3.SchemaObject {
  const first = Array.isArray(items) ? items.find(isRecord) : items;
  return isRecord(first) ? convertJsonSchemaToOpenApiSchema(first) : {};
}

function readProperties(
  properties: Record<string, unknown>,
): Record<string, OpenAPIV3.SchemaObject> {
  const converted: Record<string, OpenAPIV3.SchemaObject> = {};
  for (const [name, schema] of Object.entries(properties)) {
    if (isRecord(schema)) {
      converted[name] = convertJsonSchemaToOpenApiSchema(schema);
    }
  }
  return converted;
}
