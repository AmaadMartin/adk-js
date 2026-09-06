/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../../utils/experimental.js';
import {isRecord} from '../../../utils/type_guards.js';
import {
  ApplicationIntegrationError,
  ApplicationIntegrationErrorCode,
} from '../errors.js';
import {ApiTransport} from './api_transport.js';

const CONNECTORS_ENDPOINT = 'https://connectors.googleapis.com';

/**
 * How long to wait for a schema-metadata operation before giving up.
 *
 * The Connectors API answers these in a few seconds. The bound exists so a
 * stuck operation fails the agent's turn instead of hanging it.
 */
const MAX_POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 1000;

/** Where a connection routes its traffic, and whether it accepts caller auth. */
export interface ConnectionDetails {
  name: string;
  serviceName: string;
  host: string;
  authOverrideEnabled: boolean;
}

/** An entity's record schema and the operations the connector supports on it. */
export interface EntitySchemaAndOperations {
  schema: Record<string, unknown>;
  operations: string[];
}

/** An action's input and output schemas, with its human-readable labels. */
export interface ActionSchema {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  description: string;
  displayName: string;
}

export interface ConnectionsClientOptions {
  project: string;
  location: string;
  connection: string;
  serviceAccountJson?: string;
}

/** Reads connection metadata from the Integration Connectors API. */
@experimental
export class ConnectionsClient {
  private readonly project: string;
  private readonly location: string;
  private readonly connection: string;
  private readonly transport: ApiTransport;

  constructor(options: ConnectionsClientOptions) {
    this.project = options.project;
    this.location = options.location;
    this.connection = options.connection;
    this.transport = new ApiTransport({
      project: options.project,
      location: options.location,
      serviceAccountJson: options.serviceAccountJson,
      resourceDescription: `connection(${options.connection})`,
    });
  }

  /** Retrieves where the connection routes traffic and how it authenticates. */
  @experimental
  async getConnectionDetails(): Promise<ConnectionDetails> {
    const data = asRecord(
      await this.transport.get(`${this.connectionUrl()}?view=BASIC`),
    );
    const host = readString(data['host']);
    return {
      name: readString(data['name']),
      // A connection reached through a TLS service directory advertises a
      // different directory from the plain one, so the host decides which.
      serviceName: host
        ? readString(data['tlsServiceDirectory'])
        : readString(data['serviceDirectory']),
      host,
      authOverrideEnabled: data['authOverrideEnabled'] === true,
    };
  }

  /** Retrieves an entity's record schema and its supported operations. */
  @experimental
  async getEntitySchemaAndOperations(
    entity: string,
  ): Promise<EntitySchemaAndOperations> {
    const url =
      `${this.connectionUrl()}/connectionSchemaMetadata:getEntityType` +
      `?entityId=${encodeURIComponent(entity)}`;
    const response = await this.startOperation(
      url,
      `Failed to get entity schema and operations for entity: ${entity}`,
    );
    return {
      schema: asRecord(response['jsonSchema']),
      operations: readStringArray(response['operations']),
    };
  }

  /** Retrieves an action's input and output schemas. */
  @experimental
  async getActionSchema(action: string): Promise<ActionSchema> {
    const url =
      `${this.connectionUrl()}/connectionSchemaMetadata:getAction` +
      `?actionId=${encodeURIComponent(action)}`;
    const response = await this.startOperation(
      url,
      `Failed to get action schema for action: ${action}`,
    );
    return {
      inputSchema: asRecord(response['inputJsonSchema']),
      outputSchema: asRecord(response['outputJsonSchema']),
      description: readString(response['description']),
      displayName: readString(response['displayName']),
    };
  }

  private connectionUrl(): string {
    return (
      `${CONNECTORS_ENDPOINT}/v1/projects/${this.project}` +
      `/locations/${this.location}/connections/${this.connection}`
    );
  }

  /**
   * Starts a long-running schema-metadata call and returns its `response`.
   *
   * @param missingOperationMessage Reported when the API answers without naming
   *     an operation to poll.
   */
  private async startOperation(
    url: string,
    missingOperationMessage: string,
  ): Promise<Record<string, unknown>> {
    const started = asRecord(await this.transport.get(url));
    const operationName = readString(started['name']);
    if (!operationName) {
      throw new ApplicationIntegrationError(
        ApplicationIntegrationErrorCode.REQUEST_FAILED,
        missingOperationMessage,
      );
    }
    const operation = await this.pollOperation(operationName);
    return asRecord(operation['response']);
  }

  private async pollOperation(
    operationName: string,
  ): Promise<Record<string, unknown>> {
    const url = `${CONNECTORS_ENDPOINT}/v1/${operationName}`;
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(POLL_INTERVAL_MS);
      }
      const operation = asRecord(await this.transport.get(url));
      if (operation['done'] === true) {
        return operation;
      }
    }
    throw new ApplicationIntegrationError(
      ApplicationIntegrationErrorCode.REQUEST_FAILED,
      `Operation ${operationName} did not complete after` +
        ` ${MAX_POLL_ATTEMPTS} attempts.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
