/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {asJsonObject} from '../../../utils/json_utils.js';
import {CLOUD_PLATFORM_SCOPE} from './api_transport.js';

/**
 * Builders for the OpenAPI document that describes `ExecuteConnection` calls
 * against an Integration Connectors connection.
 *
 * Every literal here is observable: the model reads the summaries and
 * descriptions, and the `$ref` targets, `operationId` templates and
 * `x-operation` values decide what reaches the wire. They match adk-python's
 * `ConnectionsClient` static builders character for character.
 */

/** Host that serves the generated `:execute` endpoints. */
const INTEGRATIONS_SERVER_URL = 'https://integrations.googleapis.com';

/** Extra guidance appended to the description of a custom-query action. */
const EXECUTE_QUERY_GUIDANCE =
  ' Use pageSize = 50 and timeout = 120 until user specifies a different' +
  ' value otherwise. If user provides a query in natural language, convert it' +
  ' to SQL query and then execute it using the tool.';

/** Fields shared by every entity request schema. */
const CONNECTION_IDENTITY_PROPERTIES = {
  operation: {$ref: '#/components/schemas/operation'},
  connectionName: {$ref: '#/components/schemas/connectionName'},
  serviceName: {$ref: '#/components/schemas/serviceName'},
  host: {$ref: '#/components/schemas/host'},
} as const;

/** The {@link CONNECTION_IDENTITY_PROPERTIES} names, every one of them required. */
const CONNECTION_IDENTITY_REQUIRED = Object.keys(
  CONNECTION_IDENTITY_PROPERTIES,
);

/** Reference to the schema holding the dynamic end-user credential. */
const DYNAMIC_AUTH_CONFIG_PROPERTY = {
  dynamicAuthConfig: {$ref: '#/components/schemas/dynamicAuthConfig'},
} as const;

/** Reference to the shared `ExecuteConnection` response schema. */
const EXECUTE_CONNECTOR_RESPONSE_REF =
  '#/components/schemas/execute-connector_Response';

/** The `type` a schema in the generated spec can carry. */
type SchemaObjectType =
  | OpenAPIV3.ArraySchemaObjectType
  | OpenAPIV3.NonArraySchemaObjectType;

/** Every {@link SchemaObjectType}, for narrowing a connector `type` name. */
const OPENAPI_SCHEMA_TYPES = new Set<string>([
  'array',
  'boolean',
  'integer',
  'number',
  'object',
  'string',
]);

/**
 * OpenAPI extension fields the connector spec puts on every operation. They
 * record which connector call an operation stands for, so a toolset reading
 * the generated spec can rebuild it.
 */
export interface ConnectorOperationExtensions {
  'x-operation': string;
  'x-entity'?: string;
  'x-action'?: string;
}

/** One generated path in the connector spec. */
export type ConnectorPathItem =
  OpenAPIV3.PathItemObject<ConnectorOperationExtensions>;

/**
 * The generated connector OpenAPI document. `components.schemas` is required,
 * because every generated operation refers to a schema recorded there.
 */
export interface ConnectorSpec extends OpenAPIV3.Document<ConnectorOperationExtensions> {
  components: OpenAPIV3.ComponentsObject & {
    schemas: Record<string, OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject>;
  };
}

/** Builds the connector spec skeleton, with no paths and the shared schemas. */
export function getConnectorBaseSpec(): ConnectorSpec {
  return {
    openapi: '3.0.1',
    info: {
      title: 'ExecuteConnection',
      description: 'This tool can execute a query on connection',
      version: '4',
    },
    servers: [{url: INTEGRATIONS_SERVER_URL}],
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
        entityId: {
          type: 'string',
          description: 'Name of the entity',
        },
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

/** Builds the path item that executes a connector action. */
export function getActionOperation(
  action: string,
  operation: string,
  actionDisplayName: string,
  toolName: string,
  toolInstructions: string,
): ConnectorPathItem {
  let description = `Use this tool to execute ${action}`;
  if (operation === 'EXECUTE_QUERY') {
    description += EXECUTE_QUERY_GUIDANCE;
  }
  return connectorOperation({
    summary: actionDisplayName,
    description: `${description} ${toolInstructions}`,
    operationId: `${toolName}_${actionDisplayName}`,
    extensions: {'x-operation': operation, 'x-action': action},
    requestRef: `#/components/schemas/${actionDisplayName}_Request`,
    responseRef: `#/components/schemas/${actionDisplayName}_Response`,
  });
}

/** What an entity path-item builder reads. */
interface EntityOperationContext {
  entity: string;
  /** The entity's JSON schema, quoted in a read operation's description. */
  schemaAsString: string;
  toolName: string;
  toolInstructions: string;
}

/** Builds the request schema of a create-entity call. */
function createOperationRequest(entity: string): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    required: [
      'connectorInputPayload',
      ...CONNECTION_IDENTITY_REQUIRED,
      'entity',
    ],
    properties: {
      connectorInputPayload: {
        $ref: `#/components/schemas/connectorInputPayload_${entity}`,
      },
      ...CONNECTION_IDENTITY_PROPERTIES,
      entity: {$ref: '#/components/schemas/entity'},
      ...DYNAMIC_AUTH_CONFIG_PROPERTY,
    },
  };
}

/** Builds the request schema of an update-entity call. */
function updateOperationRequest(entity: string): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    required: [
      'connectorInputPayload',
      'entityId',
      ...CONNECTION_IDENTITY_REQUIRED,
      'entity',
    ],
    properties: {
      connectorInputPayload: {
        $ref: `#/components/schemas/connectorInputPayload_${entity}`,
      },
      entityId: {$ref: '#/components/schemas/entityId'},
      ...CONNECTION_IDENTITY_PROPERTIES,
      entity: {$ref: '#/components/schemas/entity'},
      ...DYNAMIC_AUTH_CONFIG_PROPERTY,
      filterClause: {$ref: '#/components/schemas/filterClause'},
    },
  };
}

/** Builds the request schema of a get-entity call. */
function getOperationRequest(): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    required: ['entityId', ...CONNECTION_IDENTITY_REQUIRED, 'entity'],
    properties: {
      entityId: {$ref: '#/components/schemas/entityId'},
      ...CONNECTION_IDENTITY_PROPERTIES,
      entity: {$ref: '#/components/schemas/entity'},
      ...DYNAMIC_AUTH_CONFIG_PROPERTY,
    },
  };
}

/** Builds the request schema of a delete-entity call, a get plus a filter. */
function deleteOperationRequest(): OpenAPIV3.SchemaObject {
  const base = getOperationRequest();
  return {
    ...base,
    properties: {
      ...base.properties,
      filterClause: {$ref: '#/components/schemas/filterClause'},
    },
  };
}

/** Builds the request schema of a list-entities call. */
function listOperationRequest(): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    required: [...CONNECTION_IDENTITY_REQUIRED, 'entity'],
    properties: {
      filterClause: {$ref: '#/components/schemas/filterClause'},
      pageSize: {$ref: '#/components/schemas/pageSize'},
      pageToken: {$ref: '#/components/schemas/pageToken'},
      ...CONNECTION_IDENTITY_PROPERTIES,
      entity: {$ref: '#/components/schemas/entity'},
      sortByColumns: {$ref: '#/components/schemas/sortByColumns'},
      ...DYNAMIC_AUTH_CONFIG_PROPERTY,
    },
  };
}

/** What one entity operation contributes to the path item built for it. */
interface EntityOperationSpec {
  request(entity: string): OpenAPIV3.SchemaObject;
  /** Value of the generated `x-operation` extension. */
  xOperation: string;
  summary(context: EntityOperationContext): string;
  description(context: EntityOperationContext): string;
  /** Describes the response payload, which the read operations spell out. */
  responseDescription?(context: EntityOperationContext): string;
}

/** Builds the request schema and the path item of one entity operation. */
interface EntityOperationBuilder {
  request(entity: string): OpenAPIV3.SchemaObject;
  operation(context: EntityOperationContext): ConnectorPathItem;
}

/**
 * The entity operations this package can express, keyed by the lowercase name
 * the connector reports. The key also spells the generated `operationId` and
 * request schema name, so neither is repeated here.
 */
const ENTITY_OPERATION_SPECS: Record<string, EntityOperationSpec> = {
  create: {
    request: createOperationRequest,
    xOperation: 'CREATE_ENTITY',
    summary: ({entity}) => `Creates a new ${entity}`,
    description: ({entity, toolInstructions}) =>
      `Creates a new ${entity}. ${toolInstructions}`,
  },
  update: {
    request: updateOperationRequest,
    xOperation: 'UPDATE_ENTITY',
    summary: ({entity}) => `Updates the ${entity}`,
    description: ({entity, toolInstructions}) =>
      `Updates the ${entity}. ${toolInstructions}`,
  },
  delete: {
    request: deleteOperationRequest,
    xOperation: 'DELETE_ENTITY',
    summary: ({entity}) => `Delete the ${entity}`,
    description: ({entity, toolInstructions}) =>
      `Deletes the ${entity}. ${toolInstructions}`,
  },
  list: {
    request: listOperationRequest,
    xOperation: 'LIST_ENTITIES',
    summary: ({entity}) => `List ${entity}`,
    description: ({entity, toolInstructions}) =>
      `Returns the list of ${entity} data. If the page token was available` +
      ' in the response, let users know there are more records available.' +
      ' Ask if the user wants to fetch the next page of results. When' +
      ' passing filter use the\n                following format:' +
      " `field_name1='value1' AND field_name2='value2'\n" +
      `                \`. ${toolInstructions}`,
    responseDescription: ({entity, schemaAsString}) =>
      `Returns a list of ${entity} of json schema: ${schemaAsString}`,
  },
  get: {
    request: getOperationRequest,
    xOperation: 'GET_ENTITY',
    summary: ({entity}) => `Get ${entity}`,
    description: ({entity, toolInstructions}) =>
      `Returns the details of the ${entity}. ${toolInstructions}`,
    responseDescription: ({entity, schemaAsString}) =>
      `Returns ${entity} of json schema: ${schemaAsString}`,
  },
};

/** Turns one operation spec into the builder the generator calls. */
function entityOperationBuilder(
  name: string,
  spec: EntityOperationSpec,
): EntityOperationBuilder {
  return {
    request: spec.request,
    operation: (context) =>
      connectorOperation({
        summary: spec.summary(context),
        description: spec.description(context),
        operationId: `${context.toolName}_${name}_${context.entity}`,
        extensions: {
          'x-operation': spec.xOperation,
          'x-entity': context.entity,
        },
        requestRef: `#/components/schemas/${name}_${context.entity}_Request`,
        responseDescription: spec.responseDescription?.(context),
      }),
  };
}

/**
 * The builders keyed by operation name. A `Map` rather than an object, so a
 * reported name such as `constructor` misses instead of reaching
 * `Object.prototype`.
 */
export const ENTITY_OPERATIONS: ReadonlyMap<string, EntityOperationBuilder> =
  new Map(
    Object.entries(ENTITY_OPERATION_SPECS).map(([name, spec]) => [
      name,
      entityOperationBuilder(name, spec),
    ]),
  );

/** Builds the request schema of a generic action call. */
export function actionRequest(action: string): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    required: [
      ...CONNECTION_IDENTITY_REQUIRED,
      'action',
      'connectorInputPayload',
    ],
    properties: {
      ...CONNECTION_IDENTITY_PROPERTIES,
      action: {$ref: '#/components/schemas/action'},
      connectorInputPayload: {
        $ref: `#/components/schemas/connectorInputPayload_${action}`,
      },
      ...DYNAMIC_AUTH_CONFIG_PROPERTY,
    },
  };
}

/** Builds the response schema of an action call. */
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

/** Builds the request schema of the `ExecuteCustomQuery` action. */
export function executeCustomQueryRequest(): OpenAPIV3.SchemaObject {
  return {
    type: 'object',
    required: [
      ...CONNECTION_IDENTITY_REQUIRED,
      'action',
      'query',
      'timeout',
      'pageSize',
    ],
    properties: {
      ...CONNECTION_IDENTITY_PROPERTIES,
      action: {$ref: '#/components/schemas/action'},
      query: {$ref: '#/components/schemas/query'},
      timeout: {$ref: '#/components/schemas/timeout'},
      pageSize: {$ref: '#/components/schemas/pageSize'},
      ...DYNAMIC_AUTH_CONFIG_PROPERTY,
    },
  };
}

/**
 * Converts a connector JSON schema into the OpenAPI schema the generated spec
 * carries, keeping `description`, resolving a union `type` and recursing into
 * `properties` and `items`. Every other keyword is dropped.
 */
export function convertJsonSchemaToOpenApiSchema(
  jsonSchema: Record<string, unknown>,
): OpenAPIV3.SchemaObject {
  const description = jsonSchema['description'];
  const {type, nullable} = resolveSchemaType(jsonSchema['type']);
  const base: OpenAPIV3.NonArraySchemaObject = {};
  if (typeof description === 'string') {
    base.description = description;
  }
  if (nullable) {
    base.nullable = true;
  }

  if (type === 'array') {
    return {
      ...base,
      type,
      items: convertJsonSchemaToOpenApiSchema(
        asJsonObject(jsonSchema['items']) ?? {},
      ),
    };
  }
  const properties = asJsonObject(jsonSchema['properties']);
  if (type === 'object' && properties) {
    return {
      ...base,
      type,
      properties: Object.fromEntries(
        Object.entries(properties).map(([name, propertySchema]) => [
          name,
          convertJsonSchemaToOpenApiSchema(asJsonObject(propertySchema) ?? {}),
        ]),
      ),
    };
  }
  return type === undefined ? base : {...base, type};
}

/**
 * Resolves the `type` keyword of a connector JSON schema. It may name one
 * type or list a union; a union that offers `null` marks the schema nullable
 * and resolves to its first other entry. A name OpenAPI 3.0 has no form for
 * is dropped, which leaves the schema unconstrained.
 */
function resolveSchemaType(value: unknown): {
  type?: SchemaObjectType;
  nullable?: true;
} {
  if (!Array.isArray(value)) {
    return isSchemaObjectType(value) ? {type: value} : {};
  }
  if (!value.includes('null')) {
    return isSchemaObjectType(value[0]) ? {type: value[0]} : {};
  }
  const named = value.find((entry) => entry !== 'null');
  return isSchemaObjectType(named)
    ? {nullable: true, type: named}
    : {nullable: true};
}

/** Narrows a connector `type` name to one OpenAPI 3.0 can express. */
function isSchemaObjectType(value: unknown): value is SchemaObjectType {
  return typeof value === 'string' && OPENAPI_SCHEMA_TYPES.has(value);
}

/**
 * Builds the path item of one generated connector operation. Every operation
 * posts to the same endpoint, so they differ only in their wording, their
 * extensions, and the schemas their request and response refer to.
 */
function connectorOperation(options: {
  summary: string;
  description: string;
  operationId: string;
  extensions: ConnectorOperationExtensions;
  requestRef: string;
  /** Defaults to the shared `ExecuteConnection` response schema. */
  responseRef?: string;
  /** Describes the response payload, which the read operations spell out. */
  responseDescription?: string;
}): ConnectorPathItem {
  const responseSchema: OpenAPIV3.ReferenceObject & {description?: string} = {
    $ref: options.responseRef ?? EXECUTE_CONNECTOR_RESPONSE_REF,
  };
  if (options.responseDescription !== undefined) {
    responseSchema.description = options.responseDescription;
  }
  return {
    post: {
      summary: options.summary,
      description: options.description,
      operationId: options.operationId,
      ...options.extensions,
      requestBody: {
        content: {'application/json': {schema: {$ref: options.requestRef}}},
      },
      responses: {
        '200': {
          description: 'Success response',
          content: {'application/json': {schema: responseSchema}},
        },
      },
    },
  };
}
