/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../../utils/experimental.js';
import {asJsonObject, readString} from '../../../utils/json_utils.js';
import {ApiTransport} from './api_transport.js';

/** Host serving the Integration Connectors API. */
const CONNECTORS_URL = 'https://connectors.googleapis.com';

/** Delay between two polls of a long-running connector operation. */
const POLL_INTERVAL_MS = 1000;

/**
 * Total budget for polling one long-running connector operation. adk-python
 * polls forever; a stuck operation would hang the process, so the port stops.
 */
const POLL_TIMEOUT_MS = 120_000;

/** Service details of an Integration Connectors connection. */
export interface ConnectionDetails {
  /** Full resource name of the connection. */
  name: string;
  /** Service directory the connection is reachable through. */
  serviceName: string;
  /** Host name, set only for a TLS service directory. */
  host: string;
  /** Whether the connection accepts an end-user credential from the caller. */
  authOverrideEnabled: boolean;
}

/** JSON schema of an entity plus the operations the connector supports on it. */
export interface EntitySchemaAndOperations {
  schema: Record<string, unknown>;
  operations: string[];
}

/** Input and output schemas of a connector action. */
export interface ActionSchema {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  description: string;
  displayName: string;
}

/** Connection a {@link ConnectionsClient} reads metadata for. */
export interface ConnectionsClientOptions {
  /** Google Cloud project id. */
  project: string;
  /** Google Cloud location, for example `us-central1`. */
  location: string;
  /** Connection name. */
  connection: string;
  /**
   * Raw service account key file contents. Falls back to Application Default
   * Credentials when omitted.
   */
  serviceAccountJson?: string;
}

/**
 * Reads connection metadata and entity or action schemas from the Google Cloud
 * Integration Connectors API.
 */
@experimental
export class ConnectionsClient {
  private readonly transport: ApiTransport;

  constructor(private readonly options: ConnectionsClientOptions) {
    this.transport = new ApiTransport(options.serviceAccountJson);
  }

  /**
   * Retrieves the service name, host and auth-override flag of the connection.
   *
   * @throws {Error} If the API call fails.
   */
  @experimental
  async getConnectionDetails(): Promise<ConnectionDetails> {
    const data = await this.get(`${this.connectionUrl()}?view=BASIC`);
    const host = readString(data, 'host');
    return {
      name: readString(data, 'name'),
      // A TLS service directory is published under a different field.
      serviceName: host
        ? readString(data, 'tlsServiceDirectory')
        : readString(data, 'serviceDirectory'),
      host,
      authOverrideEnabled: data['authOverrideEnabled'] === true,
    };
  }

  /**
   * Retrieves the JSON schema of an entity and the operations the connector
   * supports on it.
   *
   * @throws {Error} If the API call fails or returns no operation to poll.
   */
  @experimental
  async getEntitySchemaAndOperations(
    entity: string,
  ): Promise<EntitySchemaAndOperations> {
    const response = await this.startOperation(
      `${this.connectionUrl()}/connectionSchemaMetadata:getEntityType` +
        `?entityId=${encodeURIComponent(entity)}`,
      `Failed to get entity schema and operations for entity: ${entity}`,
    );
    const operations = response['operations'];
    return {
      schema: asJsonObject(response['jsonSchema']) ?? {},
      operations: Array.isArray(operations)
        ? operations.filter((op): op is string => typeof op === 'string')
        : [],
    };
  }

  /**
   * Retrieves the input and output JSON schemas of a connector action.
   *
   * @throws {Error} If the API call fails or returns no operation to poll.
   */
  @experimental
  async getActionSchema(action: string): Promise<ActionSchema> {
    const response = await this.startOperation(
      `${this.connectionUrl()}/connectionSchemaMetadata:getAction` +
        `?actionId=${encodeURIComponent(action)}`,
      `Failed to get action schema for action: ${action}`,
    );
    return {
      inputSchema: asJsonObject(response['inputJsonSchema']) ?? {},
      outputSchema: asJsonObject(response['outputJsonSchema']) ?? {},
      description: readString(response, 'description'),
      displayName: readString(response, 'displayName'),
    };
  }

  private connectionUrl(): string {
    return (
      `${CONNECTORS_URL}/v1/projects/${this.options.project}/locations/` +
      `${this.options.location}/connections/${this.options.connection}`
    );
  }

  /** Issues a metadata call and returns the `response` of its operation. */
  private async startOperation(
    url: string,
    missingOperationMessage: string,
  ): Promise<Record<string, unknown>> {
    const started = await this.get(url);
    const operationName = started['name'];
    if (typeof operationName !== 'string' || operationName === '') {
      throw new Error(missingOperationMessage);
    }
    const operation = await this.pollOperation(operationName);
    return asJsonObject(operation['response']) ?? {};
  }

  private async pollOperation(
    operationName: string,
  ): Promise<Record<string, unknown>> {
    const url = `${CONNECTORS_URL}/v1/${operationName}`;
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const operation = await this.get(url);
      if (operation['done'] === true) {
        return operation;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Operation ${operationName} did not complete within ${POLL_TIMEOUT_MS}ms`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  private get(url: string): Promise<Record<string, unknown>> {
    return this.transport.fetchJson({
      url,
      method: 'GET',
      invalidRequestMessage:
        'Invalid request. Please check the provided values of' +
        ` project(${this.options.project}), location(${this.options.location}),` +
        ` connection(${this.options.connection}).`,
    });
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
