/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {InputValidationError} from '../../../errors/input_validation_error.js';
import {formatError} from '../../../utils/error_utils.js';
import {experimental} from '../../../utils/experimental.js';
import {asJsonObject} from '../../../utils/json_utils.js';
import {logger} from '../../../utils/logger.js';
import type {ApplicationIntegrationToolsetOptions} from '../application_integration_toolset.js';
import {ApiTransport} from './api_transport.js';
import {
  ActionSchema,
  ConnectionDetails,
  ConnectionsClient,
} from './connections_client.js';
import {
  actionRequest,
  actionResponse,
  ConnectorSpec,
  convertJsonSchemaToOpenApiSchema,
  ENTITY_OPERATIONS,
  executeCustomQueryRequest,
  getActionOperation,
  getConnectorBaseSpec,
} from './connector_spec_builders.js';

/**
 * Integration that proxies connector calls. It must exist in the same region
 * as the connection, together with an `api_trigger/ExecuteConnection` trigger.
 */
const DEFAULT_CONNECTION_INTEGRATION = 'ExecuteConnection';

/** The action whose request carries a SQL query instead of a payload. */
const EXECUTE_CUSTOM_QUERY_ACTION = 'ExecuteCustomQuery';

/** The resource an {@link IntegrationClient} reads metadata for. */
export type IntegrationClientOptions = Pick<
  ApplicationIntegrationToolsetOptions,
  | 'project'
  | 'location'
  | 'connectionTemplateOverride'
  | 'integration'
  | 'triggers'
  | 'connection'
  | 'entityOperations'
  | 'actions'
  | 'serviceAccountJson'
>;

/**
 * Reads Application Integration and Integration Connectors metadata and turns
 * it into the OpenAPI document the OpenAPI tooling consumes.
 */
@experimental
export class IntegrationClient {
  private readonly transport: ApiTransport;
  private connectionsClient?: ConnectionsClient;

  constructor(private readonly options: IntegrationClientOptions) {
    this.transport = new ApiTransport(options.serviceAccountJson);
  }

  /**
   * Returns the connector metadata client, building it on first use. One
   * instance is shared, so a toolset resolves its credentials once instead of
   * once per caller.
   *
   * @throws {InputValidationError} If no connection name was configured.
   */
  private connectorClient(): ConnectionsClient {
    const {connection} = this.options;
    if (!connection) {
      throw new InputValidationError(
        'A connection name is required to read connector metadata.',
      );
    }
    this.connectionsClient ??= new ConnectionsClient({
      project: this.options.project,
      location: this.options.location,
      connection,
      serviceAccountJson: this.options.serviceAccountJson,
    });
    return this.connectionsClient;
  }

  /**
   * Retrieves the service details of the configured connection.
   *
   * @throws {Error} If the API call fails.
   */
  @experimental
  async getConnectionDetails(): Promise<ConnectionDetails> {
    return this.connectorClient().getConnectionDetails();
  }

  /**
   * Generates the OpenAPI spec of an integration's API triggers.
   *
   * @throws {InputValidationError} If the API rejects the integration or the
   *     triggers.
   * @throws {Error} If the call fails or returns no usable spec.
   */
  @experimental
  async getOpenApiSpecForIntegration(): Promise<OpenAPIV3.Document> {
    const headers: Record<string, string> = {};
    if (!this.options.serviceAccountJson) {
      headers['x-goog-user-project'] =
        (await this.transport.getQuotaProjectId()) ?? this.options.project;
    }

    const response = await this.transport.fetchJson({
      url:
        `https://${this.options.location}-integrations.googleapis.com/v1/projects/` +
        `${this.options.project}/locations/${this.options.location}:generateOpenApiSpec`,
      method: 'POST',
      headers,
      body: {
        apiTriggerResources: [
          {
            integrationResource: this.options.integration,
            triggerId: this.options.triggers,
          },
        ],
        fileFormat: 'JSON',
      },
      invalidRequestMessage:
        'Invalid request. Please check the provided values of' +
        ` project(${this.options.project}), location(${this.options.location}),` +
        ` integration(${this.options.integration}).`,
    });

    const specString = response['openApiSpec'];
    if (typeof specString !== 'string') {
      throw new Error(
        'Integration API response did not include an OpenAPI spec.',
      );
    }
    let spec: unknown;
    try {
      spec = JSON.parse(specString);
    } catch (error: unknown) {
      throw new Error(`An unexpected error occurred: ${formatError(error)}`);
    }
    if (!isOpenApiDocument(spec)) {
      throw new Error(
        'Generated OpenAPI spec must be a JSON object declaring an openapi' +
          ' version, an info object and a paths object.',
      );
    }
    logger.debug(
      `Generated an OpenAPI spec for integration ${this.options.integration} with` +
        ` ${Object.keys(spec.paths).length} paths.`,
    );
    return spec;
  }

  /**
   * Generates an OpenAPI spec describing `ExecuteConnection` calls for the
   * configured entity operations and actions.
   *
   * @param toolName Prefix of every generated `operationId`.
   * @param toolInstructions Appended to every generated description.
   * @throws {InputValidationError} If an operation is unknown.
   */
  @experimental
  async getOpenApiSpecForConnection(
    toolName: string,
    toolInstructions: string,
  ): Promise<OpenAPIV3.Document> {
    const entities = Object.entries(this.options.entityOperations ?? {});
    const actions = this.options.actions ?? [];
    const integrationName =
      this.options.connectionTemplateOverride ?? DEFAULT_CONNECTION_INTEGRATION;
    const connectionsClient = this.connectorClient();
    const spec = getConnectorBaseSpec();

    for (const [entity, requestedOperations] of entities) {
      const {schema, operations} =
        await connectionsClient.getEntitySchemaAndOperations(entity);
      spec.components.schemas[`connectorInputPayload_${entity}`] =
        convertJsonSchemaToOpenApiSchema(schema);
      const selected =
        requestedOperations.length > 0 ? requestedOperations : operations;
      for (const operation of selected) {
        addEntityOperation(spec, {
          path: this.executePath(
            integrationName,
            `${operation.toLowerCase()}_${entity}`,
          ),
          entity,
          operation,
          schemaAsString: JSON.stringify(schema),
          toolName,
          toolInstructions,
        });
      }
    }

    for (const action of actions) {
      addAction(spec, {
        path: this.executePath(integrationName, action),
        action,
        schema: await connectionsClient.getActionSchema(action),
        toolName,
        toolInstructions,
      });
    }

    return spec;
  }

  private executePath(integrationName: string, fragment: string): string {
    return (
      `/v2/projects/${this.options.project}/locations/${this.options.location}/integrations/` +
      `${integrationName}:execute?triggerId=api_trigger/${integrationName}` +
      `#${fragment}`
    );
  }
}

/**
 * Narrows a parsed spec to an OpenAPI document by checking the three members
 * the document type requires.
 */
function isOpenApiDocument(value: unknown): value is OpenAPIV3.Document {
  const fields = asJsonObject(value);
  return (
    !!fields &&
    typeof fields['openapi'] === 'string' &&
    !!asJsonObject(fields['info']) &&
    !!asJsonObject(fields['paths'])
  );
}

/**
 * Adds one entity operation, and the request schema it refers to, to the spec.
 *
 * @throws {InputValidationError} If the connector reports an operation this
 *     package cannot express.
 */
function addEntityOperation(
  spec: ConnectorSpec,
  options: {
    path: string;
    entity: string;
    operation: string;
    schemaAsString: string;
    toolName: string;
    toolInstructions: string;
  },
): void {
  const {path, entity, schemaAsString, toolName, toolInstructions} = options;
  const name = options.operation.toLowerCase();
  const builder = ENTITY_OPERATIONS.get(name);
  if (!builder) {
    throw new InputValidationError(
      `Invalid operation: ${options.operation} for entity: ${entity}`,
    );
  }
  spec.components.schemas[`${name}_${entity}_Request`] =
    builder.request(entity);
  spec.paths[path] = builder.operation({
    entity,
    schemaAsString,
    toolName,
    toolInstructions,
  });
}

/** Adds one connector action, and the schemas it refers to, to the spec. */
function addAction(
  spec: ConnectorSpec,
  options: {
    path: string;
    action: string;
    schema: ActionSchema;
    toolName: string;
    toolInstructions: string;
  },
): void {
  const {path, action, schema, toolName, toolInstructions} = options;
  // A display name reaches the spec as an identifier, so spaces are removed
  // to keep the generated operation and schema names valid. A connector that
  // reports no display name falls back to the action, which would otherwise
  // leave every generated name a bare `_Request` style suffix.
  const displayName = (schema.displayName || action).replace(/ /g, '');
  const schemas = spec.components.schemas;

  let operation = 'EXECUTE_ACTION';
  if (action === EXECUTE_CUSTOM_QUERY_ACTION) {
    schemas[`${displayName}_Request`] = executeCustomQueryRequest();
    operation = 'EXECUTE_QUERY';
  } else {
    schemas[`${displayName}_Request`] = actionRequest(displayName);
    schemas[`connectorInputPayload_${displayName}`] =
      convertJsonSchemaToOpenApiSchema(schema.inputSchema);
  }
  schemas[`connectorOutputPayload_${displayName}`] =
    convertJsonSchemaToOpenApiSchema(schema.outputSchema);
  schemas[`${displayName}_Response`] = actionResponse(displayName);
  spec.paths[path] = getActionOperation(
    action,
    operation,
    displayName,
    toolName,
    toolInstructions,
  );
}
