/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {experimental} from '../../../utils/experimental.js';
import {
  ApplicationIntegrationError,
  ApplicationIntegrationErrorCode,
} from '../errors.js';
import {ApiTransport} from './api_transport.js';
import {ConnectionsClient} from './connections_client.js';
import {
  actionRequest,
  actionResponse,
  ConnectorPathItemObject,
  ConnectorSpecDocument,
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
  updateOperation,
  updateOperationRequest,
} from './connector_spec_builders.js';

/**
 * The integration that runs a connector call.
 *
 * Application Integration must be provisioned in the connection's region, with
 * an integration of this name and an `api_trigger/ExecuteConnection` trigger.
 */
const DEFAULT_CONNECTION_TEMPLATE = 'ExecuteConnection';

/** The action name the connectors expose for a free-form SQL query. */
const CUSTOM_QUERY_ACTION = 'ExecuteCustomQuery';

export interface IntegrationClientOptions {
  project: string;
  location: string;
  /** Replaces the `ExecuteConnection` integration that runs connector calls. */
  connectionTemplateOverride?: string;
  integration?: string;
  triggers?: string[];
  connection?: string;
  entityOperations?: Record<string, string[]>;
  actions?: string[];
  serviceAccountJson?: string;
}

/** Builds the OpenAPI spec that describes an integration or a connection. */
@experimental
export class IntegrationClient {
  private readonly options: IntegrationClientOptions;
  private readonly transport: ApiTransport;

  constructor(options: IntegrationClientOptions) {
    this.options = options;
    this.transport = new ApiTransport({
      project: options.project,
      location: options.location,
      serviceAccountJson: options.serviceAccountJson,
      resourceDescription: `integration(${options.integration})`,
    });
  }

  /**
   * Asks Application Integration to generate the spec for the integration's
   * API triggers.
   */
  @experimental
  async getOpenApiSpecForIntegration(): Promise<OpenAPIV3.Document> {
    const {project, location, integration, triggers} = this.options;
    if (!integration || !triggers?.length) {
      throw new ApplicationIntegrationError(
        ApplicationIntegrationErrorCode.INVALID_REQUEST,
        'Integration name and triggers are required to generate an' +
          ' integration OpenAPI spec.',
      );
    }

    const url =
      `https://${location}-integrations.googleapis.com/v1/projects/` +
      `${project}/locations/${location}:generateOpenApiSpec`;

    // An explicit service account key already names the project to bill, so
    // the quota header is only needed for Application Default Credentials.
    const usingDefaultCredentials = !this.options.serviceAccountJson;
    const headers: Record<string, string> = usingDefaultCredentials
      ? {
          'x-goog-user-project':
            (await this.transport.getQuotaProjectId()) || project,
        }
      : {};

    const response = await this.transport.post(
      url,
      {
        apiTriggerResources: [
          {integrationResource: integration, triggerId: triggers},
        ],
        fileFormat: 'JSON',
      },
      headers,
    );

    return parseGeneratedSpec(
      (response as {openApiSpec?: string}).openApiSpec,
      integration,
    );
  }

  /**
   * Assembles the OpenAPI spec for the requested entity operations and actions
   * on a connection.
   *
   * @param toolName Prefix for every generated `operationId`.
   * @param toolInstructions Appended to every generated description.
   */
  @experimental
  async getOpenApiSpecForConnection(
    toolName = '',
    toolInstructions = '',
  ): Promise<ConnectorSpecDocument> {
    const {
      project,
      location,
      connection,
      entityOperations = {},
      actions = [],
      connectionTemplateOverride,
      serviceAccountJson,
    } = this.options;

    if (!connection) {
      throw new ApplicationIntegrationError(
        ApplicationIntegrationErrorCode.INVALID_REQUEST,
        'Connection name is required to generate a connection OpenAPI spec.',
      );
    }

    if (!Object.keys(entityOperations).length && !actions.length) {
      throw new ApplicationIntegrationError(
        ApplicationIntegrationErrorCode.INVALID_REQUEST,
        'No entity operations or actions provided. Please provide at least' +
          ' one of them.',
      );
    }

    const integrationName =
      connectionTemplateOverride || DEFAULT_CONNECTION_TEMPLATE;
    const connectionsClient = new ConnectionsClient({
      project,
      location,
      connection,
      serviceAccountJson,
    });

    const spec = getConnectorBaseSpec();
    const {schemas} = spec.components;
    const {paths} = spec;

    for (const [entity, requested] of Object.entries(entityOperations)) {
      const {schema, operations} =
        await connectionsClient.getEntitySchemaAndOperations(entity);
      // An empty list means every operation the connector supports.
      const selected = requested.length ? requested : operations;
      schemas[`connectorInputPayload_${entity}`] =
        convertJsonSchemaToOpenApiSchema(schema);

      const schemaAsString = JSON.stringify(schema);
      for (const operation of selected) {
        const key = operation.toLowerCase();
        const built = buildEntityOperation({
          operation: key,
          entity,
          schemaAsString,
          toolName,
          toolInstructions,
        });
        paths[this.executePath(integrationName, `${key}_${entity}`)] =
          built.pathItem;
        schemas[`${key}_${entity}_Request`] = built.requestSchema;
      }
    }

    for (const action of actions) {
      const details = await connectionsClient.getActionSchema(action);
      // A display name reaches the spec as an identifier, and a space would
      // make the generated tool name invalid.
      const displayName = details.displayName.replace(/ /g, '');
      const isCustomQuery = action === CUSTOM_QUERY_ACTION;

      if (isCustomQuery) {
        schemas[`${displayName}_Request`] = executeCustomQueryRequest();
      } else {
        schemas[`${displayName}_Request`] = actionRequest(displayName);
        schemas[`connectorInputPayload_${displayName}`] =
          convertJsonSchemaToOpenApiSchema(details.inputSchema);
      }
      schemas[`connectorOutputPayload_${displayName}`] =
        convertJsonSchemaToOpenApiSchema(details.outputSchema);
      schemas[`${displayName}_Response`] = actionResponse(displayName);

      paths[this.executePath(integrationName, action)] = getActionOperation(
        action,
        isCustomQuery ? 'EXECUTE_QUERY' : 'EXECUTE_ACTION',
        displayName,
        toolName,
        toolInstructions,
      );
    }

    return spec;
  }

  /**
   * The path of the `ExecuteConnection` integration, with `fragment`
   * distinguishing the operations that otherwise share it.
   */
  private executePath(integrationName: string, fragment: string): string {
    const {project, location} = this.options;
    return (
      `/v2/projects/${project}/locations/${location}/integrations/` +
      `${integrationName}:execute?triggerId=api_trigger/${integrationName}` +
      `#${fragment}`
    );
  }
}

/**
 * Reads the spec out of a `:generateOpenApiSpec` response.
 *
 * @throws {ApplicationIntegrationError} With code `REQUEST_FAILED` when the
 *     response carries no spec, or one that is not JSON. Either would
 *     otherwise leave the caller with an agent that has no tools and no
 *     explanation.
 */
function parseGeneratedSpec(
  spec: string | undefined,
  integration: string,
): OpenAPIV3.Document {
  if (!spec) {
    throw new ApplicationIntegrationError(
      ApplicationIntegrationErrorCode.REQUEST_FAILED,
      `Application Integration returned no OpenAPI spec for integration` +
        ` ${integration}.`,
    );
  }
  try {
    return JSON.parse(spec) as OpenAPIV3.Document;
  } catch (error) {
    throw new ApplicationIntegrationError(
      ApplicationIntegrationErrorCode.REQUEST_FAILED,
      `Application Integration returned an unreadable OpenAPI spec for` +
        ` integration ${integration}: ${(error as Error).message}`,
      {cause: error},
    );
  }
}

interface EntityOperationRequest {
  /** The requested operation, lowercased. */
  operation: string;
  entity: string;
  schemaAsString: string;
  toolName: string;
  toolInstructions: string;
}

interface EntityOperation {
  pathItem: ConnectorPathItemObject;
  requestSchema: OpenAPIV3.SchemaObject;
}

/**
 * How each supported entity operation builds its path item and its request
 * schema. The key is the operation name, lowercased.
 */
const ENTITY_OPERATIONS: Record<
  string,
  (request: EntityOperationRequest) => EntityOperation
> = {
  create: ({entity, toolName, toolInstructions}) => ({
    pathItem: createOperation(entity, toolName, toolInstructions),
    requestSchema: createOperationRequest(entity),
  }),
  update: ({entity, toolName, toolInstructions}) => ({
    pathItem: updateOperation(entity, toolName, toolInstructions),
    requestSchema: updateOperationRequest(entity),
  }),
  delete: ({entity, toolName, toolInstructions}) => ({
    pathItem: deleteOperation(entity, toolName, toolInstructions),
    requestSchema: deleteOperationRequest(),
  }),
  list: ({entity, schemaAsString, toolName, toolInstructions}) => ({
    pathItem: listOperation(entity, schemaAsString, toolName, toolInstructions),
    requestSchema: listOperationRequest(),
  }),
  get: ({entity, schemaAsString, toolName, toolInstructions}) => ({
    pathItem: getOperation(entity, schemaAsString, toolName, toolInstructions),
    requestSchema: getOperationRequest(),
  }),
};

/**
 * Builds the path item and the request schema for one entity operation.
 *
 * @throws {ApplicationIntegrationError} With code `INVALID_REQUEST` when the
 *     connector does not support the operation.
 */
function buildEntityOperation(
  request: EntityOperationRequest,
): EntityOperation {
  const build = ENTITY_OPERATIONS[request.operation];
  if (!build) {
    throw new ApplicationIntegrationError(
      ApplicationIntegrationErrorCode.INVALID_REQUEST,
      `Invalid operation: ${request.operation} for entity: ${request.entity}`,
    );
  }
  return build(request);
}
