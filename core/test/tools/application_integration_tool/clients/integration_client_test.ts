/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports the adk-python unit tests for
 * `tools/application_integration_tool/clients/integration_client` to adk-js.
 *
 * The module under test does not exist yet, so this file fails today by
 * design: it is the executable specification for the port.
 */

import {GoogleAuth, JWT} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  IntegrationClient,
  IntegrationClientOptions,
} from '../../../../src/tools/application_integration_tool/clients/integration_client.js';

const PROJECT = 'test-project';
const LOCATION = 'us-central1';
const INTEGRATION = 'test-integration';
const TRIGGERS = ['test-trigger', 'test-trigger2'];
const CONNECTION = 'test-connection';
const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: 'test@example.com',
  private_key: 'test_key',
});

const GENERATE_SPEC_URL =
  `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}` +
  `/locations/${LOCATION}:generateOpenApiSpec`;

/**
 * The document the Application Integration API returns, as a value. `paths`
 * and `info.version` are required by `OpenAPIV3.Document`, so a real
 * implementation may reject a document without them.
 */
const EXPECTED_SPEC = {
  openapi: '3.0.0',
  info: {title: 'Test Integration', version: '1.0.0'},
  paths: {},
};

const INVALID_REQUEST_RESPONSES: Array<[number, string]> = [
  [404, 'Not Found'],
  [400, 'Bad Request'],
  [404, ''],
  [400, ''],
];

/** The credential behaviour each test steers. */
interface AuthState {
  token: string | null;
  quotaProjectId?: string;
  getClientError?: Error;
  serviceAccountToken: string | null;
}

/** The two `ConnectionsClient` methods `IntegrationClient` consumes. */
interface EntitySchemaAndOperations {
  schema: Record<string, unknown>;
  operations: string[];
}

interface ActionSchema {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  displayName: string;
}

interface ConnectionsClientOptions {
  project: string;
  location: string;
  connection: string;
  serviceAccountJson?: string;
}

const auth = vi.hoisted(() => {
  const state: AuthState = {
    token: 'test_token',
    quotaProjectId: 'quota-project',
    serviceAccountToken: 'sa_token',
  };
  const getAccessToken = vi.fn(async () => ({token: state.token}));
  const getClient = vi.fn(async () => {
    if (state.getClientError) {
      throw state.getClientError;
    }
    return {getAccessToken, quotaProjectId: state.quotaProjectId};
  });
  const jwtGetAccessToken = vi.fn(async () => ({
    token: state.serviceAccountToken,
  }));
  return {state, getAccessToken, getClient, jwtGetAccessToken};
});

const connections = vi.hoisted(() => {
  const getEntitySchemaAndOperations =
    vi.fn<(entity: string) => Promise<EntitySchemaAndOperations>>();
  const getActionSchema = vi.fn<(action: string) => Promise<ActionSchema>>();
  const ConnectionsClient = vi.fn((_options: ConnectionsClientOptions) => ({
    getEntitySchemaAndOperations,
    getActionSchema,
  }));
  return {ConnectionsClient, getEntitySchemaAndOperations, getActionSchema};
});

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({getClient: auth.getClient})),
  JWT: vi.fn(() => ({getAccessToken: auth.jwtGetAccessToken})),
}));

vi.mock(
  '../../../../src/tools/application_integration_tool/clients/connections_client.js',
  () => ({ConnectionsClient: connections.ConnectionsClient}),
);

function clientOptions(
  overrides: Partial<IntegrationClientOptions>,
): IntegrationClientOptions {
  return {project: PROJECT, location: LOCATION, ...overrides};
}

/** A fresh 200 response per call, since a `Response` body is read only once. */
function specResponse(): Response {
  return new Response(
    JSON.stringify({openApiSpec: JSON.stringify(EXPECTED_SPEC)}),
    {status: 200, headers: {'Content-Type': 'application/json'}},
  );
}

function sentUrl(index = 0): string {
  return String(vi.mocked(globalThis.fetch).mock.calls[index][0]);
}

function sentInit(index = 0) {
  return vi.mocked(globalThis.fetch).mock.calls[index][1];
}

/** The request headers, read case-insensitively. */
function sentHeaders(index = 0): Headers {
  return new Headers(sentInit(index)?.headers);
}

function sentBody(index = 0): unknown {
  const body = sentInit(index)?.body;
  expect(typeof body).toBe('string');
  return JSON.parse(String(body));
}

/** The `ExecuteConnection` path the connector spec keys operations under. */
function executePath(fragment: string): string {
  return (
    `/v2/projects/${PROJECT}/locations/${LOCATION}/integrations` +
    `/ExecuteConnection:execute?triggerId=api_trigger/ExecuteConnection` +
    `#${fragment}`
  );
}

describe('IntegrationClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connections.getEntitySchemaAndOperations.mockReset();
    connections.getActionSchema.mockReset();
    auth.state.token = 'test_token';
    auth.state.quotaProjectId = 'quota-project';
    auth.state.getClientError = undefined;
    auth.state.serviceAccountToken = 'sa_token';
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not perform any I/O when constructed', () => {
    new IntegrationClient({
      project: PROJECT,
      location: LOCATION,
      integration: INTEGRATION,
      triggers: TRIGGERS,
      connection: CONNECTION,
      entityOperations: {entity: ['LIST']},
      actions: ['action1'],
      serviceAccountJson: SERVICE_ACCOUNT_JSON,
    });

    expect(connections.ConnectionsClient).not.toHaveBeenCalled();
    expect(GoogleAuth).not.toHaveBeenCalled();
    expect(JWT).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  describe('getOpenApiSpecForIntegration', () => {
    it('posts the trigger resources and returns the parsed spec', async () => {
      vi.mocked(globalThis.fetch).mockImplementation(async () =>
        specResponse(),
      );
      const client = new IntegrationClient(
        clientOptions({integration: INTEGRATION, triggers: TRIGGERS}),
      );

      await expect(client.getOpenApiSpecForIntegration()).resolves.toEqual(
        EXPECTED_SPEC,
      );

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      expect(sentUrl()).toBe(GENERATE_SPEC_URL);
      expect(sentInit()?.method).toBe('POST');
      expect(sentHeaders().get('content-type')).toBe('application/json');
      expect(sentHeaders().get('authorization')).toBe('Bearer test_token');
      expect(sentHeaders().get('x-goog-user-project')).toBe('quota-project');
      expect(sentBody()).toEqual({
        apiTriggerResources: [
          {integrationResource: INTEGRATION, triggerId: TRIGGERS},
        ],
        fileFormat: 'JSON',
      });
    });

    it('rejects when default credentials cannot be resolved', async () => {
      auth.state.getClientError = new Error('ADC not found');
      const client = new IntegrationClient(
        clientOptions({integration: INTEGRATION, triggers: TRIGGERS}),
      );

      await expect(client.getOpenApiSpecForIntegration()).rejects.toThrow(
        'Credentials error: ADC not found',
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each(INVALID_REQUEST_RESPONSES)(
      'reports status %i (%s) as an invalid request',
      async (status, statusText) => {
        vi.mocked(globalThis.fetch).mockResolvedValue(
          new Response(statusText, {status, statusText}),
        );
        const client = new IntegrationClient(
          clientOptions({integration: INTEGRATION, triggers: TRIGGERS}),
        );

        await expect(client.getOpenApiSpecForIntegration()).rejects.toThrow(
          'Invalid request. Please check the provided values of' +
            ` project(${PROJECT}), location(${LOCATION}),` +
            ` integration(${INTEGRATION}).`,
        );
      },
    );

    it('reports any other failing status as a request error', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(
        new Response('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
      );
      const client = new IntegrationClient(
        clientOptions({integration: INTEGRATION, triggers: TRIGGERS}),
      );

      await expect(client.getOpenApiSpecForIntegration()).rejects.toThrow(
        /^Request error: /,
      );
    });

    it('reports a rejected fetch as a request error and keeps the cause', async () => {
      vi.mocked(globalThis.fetch).mockRejectedValue(
        new Error('Something went wrong'),
      );
      const client = new IntegrationClient(
        clientOptions({integration: INTEGRATION, triggers: TRIGGERS}),
      );

      await expect(client.getOpenApiSpecForIntegration()).rejects.toThrow(
        /Request error: .*Something went wrong/s,
      );
    });
  });

  describe('getOpenApiSpecForConnection', () => {
    it('rejects when neither entity operations nor actions are given', async () => {
      const client = new IntegrationClient(
        clientOptions({connection: CONNECTION}),
      );

      await expect(client.getOpenApiSpecForConnection()).rejects.toThrow(
        'No entity operations or actions provided. Please provide at least' +
          ' one of them.',
      );
    });

    it('builds a path and a request schema per entity operation', async () => {
      connections.getEntitySchemaAndOperations.mockResolvedValue({
        schema: {type: 'object', properties: {id: {type: 'string'}}},
        operations: ['LIST', 'GET'],
      });
      const client = new IntegrationClient(
        clientOptions({
          connection: CONNECTION,
          entityOperations: {entity1: ['LIST', 'GET']},
        }),
      );

      const spec = await client.getOpenApiSpecForConnection();

      expect(connections.ConnectionsClient).toHaveBeenCalledTimes(1);
      expect(connections.ConnectionsClient).toHaveBeenCalledWith({
        project: PROJECT,
        location: LOCATION,
        connection: CONNECTION,
        serviceAccountJson: undefined,
      });
      expect(connections.getEntitySchemaAndOperations).toHaveBeenCalledWith(
        'entity1',
      );
      expect(Object.keys(spec.paths)).toEqual(
        expect.arrayContaining([
          executePath('list_entity1'),
          executePath('get_entity1'),
        ]),
      );
      expect(Object.keys(spec.components?.schemas ?? {})).toEqual(
        expect.arrayContaining([
          'connectorInputPayload_entity1',
          'list_entity1_Request',
          'get_entity1_Request',
        ]),
      );
    });

    it('builds a path and payload schemas per action', async () => {
      connections.getActionSchema.mockResolvedValue({
        inputSchema: {type: 'object', properties: {input: {type: 'string'}}},
        outputSchema: {type: 'object', properties: {output: {type: 'string'}}},
        displayName: 'TestAction',
      });
      const client = new IntegrationClient(
        clientOptions({connection: CONNECTION, actions: ['TestAction']}),
      );

      const spec = await client.getOpenApiSpecForConnection();

      expect(connections.ConnectionsClient).toHaveBeenCalledTimes(1);
      expect(connections.getActionSchema).toHaveBeenCalledWith('TestAction');
      expect(Object.keys(spec.paths)).toContain(executePath('TestAction'));
      expect(Object.keys(spec.components?.schemas ?? {})).toEqual(
        expect.arrayContaining([
          'TestAction_Request',
          'connectorInputPayload_TestAction',
          'connectorOutputPayload_TestAction',
          'TestAction_Response',
        ]),
      );
    });

    it('rejects an operation the connector does not support', async () => {
      connections.getEntitySchemaAndOperations.mockResolvedValue({
        schema: {type: 'object', properties: {id: {type: 'string'}}},
        operations: ['LIST', 'GET'],
      });
      const client = new IntegrationClient(
        clientOptions({
          connection: CONNECTION,
          entityOperations: {entity1: ['INVALID']},
        }),
      );

      await expect(client.getOpenApiSpecForConnection()).rejects.toThrow(
        'Invalid operation: INVALID for entity: entity1',
      );
    });
  });

  describe('credentials', () => {
    it('signs with a JSON Web Token when a service account key is set', async () => {
      vi.mocked(globalThis.fetch).mockImplementation(async () =>
        specResponse(),
      );
      const client = new IntegrationClient(
        clientOptions({
          integration: INTEGRATION,
          triggers: TRIGGERS,
          serviceAccountJson: SERVICE_ACCOUNT_JSON,
        }),
      );

      await client.getOpenApiSpecForIntegration();

      expect(JWT).toHaveBeenCalledWith({
        email: 'test@example.com',
        key: 'test_key',
        scopes: SCOPES,
      });
      expect(GoogleAuth).not.toHaveBeenCalled();
      expect(sentHeaders().get('authorization')).toBe('Bearer sa_token');
      expect(sentHeaders().get('x-goog-user-project')).toBeNull();
    });

    it('signs with default credentials when no key is set', async () => {
      vi.mocked(globalThis.fetch).mockImplementation(async () =>
        specResponse(),
      );
      const client = new IntegrationClient(
        clientOptions({integration: INTEGRATION, triggers: TRIGGERS}),
      );

      await client.getOpenApiSpecForIntegration();

      expect(GoogleAuth).toHaveBeenCalledWith({scopes: SCOPES});
      expect(JWT).not.toHaveBeenCalled();
      expect(sentHeaders().get('authorization')).toBe('Bearer test_token');
      expect(sentHeaders().get('x-goog-user-project')).toBe('quota-project');
    });

    it('rejects when the resolved credentials yield no token', async () => {
      auth.state.token = null;
      const client = new IntegrationClient(
        clientOptions({integration: INTEGRATION, triggers: TRIGGERS}),
      );

      await expect(client.getOpenApiSpecForIntegration()).rejects.toThrow(
        'Please provide a service account that has the required permissions' +
          ' to access the connection.',
      );
    });

    it('resolves credentials once per client', async () => {
      vi.mocked(globalThis.fetch).mockImplementation(async () =>
        specResponse(),
      );
      const client = new IntegrationClient(
        clientOptions({integration: INTEGRATION, triggers: TRIGGERS}),
      );

      await client.getOpenApiSpecForIntegration();
      await client.getOpenApiSpecForIntegration();

      expect(GoogleAuth).toHaveBeenCalledTimes(1);
      expect(auth.getClient).toHaveBeenCalledTimes(1);
      expect(sentHeaders(0).get('authorization')).toBe('Bearer test_token');
      expect(sentHeaders(1).get('authorization')).toBe('Bearer test_token');
    });
  });
});
