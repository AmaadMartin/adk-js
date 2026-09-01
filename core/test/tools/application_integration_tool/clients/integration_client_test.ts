/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApplicationIntegrationError,
  ApplicationIntegrationErrorCode,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ConnectorSpecDocument} from '../../../../src/tools/application_integration_tool/clients/connector_spec_builders.js';
import {
  IntegrationClient,
  IntegrationClientOptions,
} from '../../../../src/tools/application_integration_tool/clients/integration_client.js';

const authGetClient = vi.fn();
const authGetProjectId = vi.fn();

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    private readonly token: string;
    constructor(options: {credentials?: unknown}) {
      // The real client mints from the key file when one is given.
      this.token = options.credentials ? 'sa-token' : 'adc-token';
    }
    getAccessToken = async () => this.token;
    getClient = authGetClient;
    getProjectId = authGetProjectId;
  },
}));

const KEY_FILE = JSON.stringify({
  'type': 'service_account',
  'private_key': 'private-key',
  'client_email': 'sa@example.com',
});

const ENTITY_SCHEMA = {
  type: 'object',
  properties: {id: {type: 'integer'}},
};

function jsonResponse(body: unknown) {
  return {ok: true, status: 200, statusText: 'OK', json: async () => body};
}

function createClient(options: Partial<IntegrationClientOptions> = {}) {
  return new IntegrationClient({
    project: 'p',
    location: 'us-central1',
    ...options,
  });
}

/**
 * Replays the two Connectors calls that back one entity: the metadata call
 * that starts an operation, and the poll that completes it.
 */
function stubEntityMetadata(operations: string[]) {
  globalThis.fetch = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({name: 'operations/1'}))
    .mockResolvedValueOnce(
      jsonResponse({
        done: true,
        response: {jsonSchema: ENTITY_SCHEMA, operations},
      }),
    );
}

/** Replays the two Connectors calls that back one action. */
function stubActionMetadata(displayName: string) {
  globalThis.fetch = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({name: 'operations/2'}))
    .mockResolvedValueOnce(
      jsonResponse({
        done: true,
        response: {
          inputJsonSchema: {type: 'object', properties: {q: {type: 'string'}}},
          outputJsonSchema: {type: 'object', properties: {r: {type: 'string'}}},
          description: 'runs a thing',
          displayName,
        },
      }),
    );
}

function pathFor(spec: ConnectorSpecDocument, fragment: string): string {
  const match = Object.keys(spec.paths).find((path) =>
    path.endsWith(`#${fragment}`),
  );
  if (!match) {
    expect.fail(
      `no path ending in #${fragment}; got ${Object.keys(spec.paths).join(', ')}`,
    );
  }
  return match;
}

describe('IntegrationClient', () => {
  beforeEach(() => {
    authGetClient.mockResolvedValue({quotaProjectId: 'quota-project'});
    authGetProjectId.mockResolvedValue('adc-project');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('getOpenApiSpecForIntegration', () => {
    it('posts the api trigger resources and parses the generated spec', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({openApiSpec: '{"openapi":"3.0.1","paths":{}}'}),
        );

      const spec = await createClient({
        integration: 'test-integration',
        triggers: ['api_trigger/test_trigger'],
      }).getOpenApiSpecForIntegration();

      expect(spec).toEqual({openapi: '3.0.1', paths: {}});
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://us-central1-integrations.googleapis.com/v1/projects/p' +
          '/locations/us-central1:generateOpenApiSpec',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            apiTriggerResources: [
              {
                integrationResource: 'test-integration',
                triggerId: ['api_trigger/test_trigger'],
              },
            ],
            fileFormat: 'JSON',
          }),
        }),
      );
    });

    it('sends the quota project when using default credentials', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: '{}'}));

      await createClient({
        integration: 'test-integration',
        triggers: ['t'],
      }).getOpenApiSpecForIntegration();

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(init?.headers).toMatchObject({
        'x-goog-user-project': 'quota-project',
      });
    });

    it('omits the quota project when a service account key is supplied', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: '{}'}));

      await createClient({
        integration: 'test-integration',
        triggers: ['t'],
        serviceAccountJson: KEY_FILE,
      }).getOpenApiSpecForIntegration();

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(init?.headers).not.toHaveProperty('x-goog-user-project');
      expect(init?.headers).toMatchObject({'Authorization': 'Bearer sa-token'});
    });

    it('falls back to the project when ADC declares no quota project', async () => {
      authGetClient.mockResolvedValue({quotaProjectId: undefined});
      authGetProjectId.mockResolvedValue('');
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: '{}'}));

      await createClient({
        integration: 'test-integration',
        triggers: ['t'],
      }).getOpenApiSpecForIntegration();

      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(init?.headers).toMatchObject({'x-goog-user-project': 'p'});
    });

    it('fails when the API returns no spec', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));

      const error = await createClient({
        integration: 'test-integration',
        triggers: ['t'],
      })
        .getOpenApiSpecForIntegration()
        .catch((e: unknown) => e);

      expect((error as ApplicationIntegrationError).code).toBe(
        ApplicationIntegrationErrorCode.REQUEST_FAILED,
      );
      expect((error as Error).message).toBe(
        'Application Integration returned no OpenAPI spec for integration' +
          ' test-integration.',
      );
    });

    it('fails when the returned spec is not JSON', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: 'not json'}));

      const error = await createClient({
        integration: 'test-integration',
        triggers: ['t'],
      })
        .getOpenApiSpecForIntegration()
        .catch((e: unknown) => e);

      expect((error as ApplicationIntegrationError).code).toBe(
        ApplicationIntegrationErrorCode.REQUEST_FAILED,
      );
      expect((error as Error).message).toMatch(
        /returned an unreadable OpenAPI spec for integration test-integration/,
      );
    });

    it.each([
      {integration: undefined, triggers: ['t'], case: 'no integration'},
      {integration: 'i', triggers: undefined, case: 'no triggers'},
      {integration: 'i', triggers: [], case: 'an empty trigger list'},
    ])('rejects $case', async ({integration, triggers}) => {
      const error = await createClient({integration, triggers})
        .getOpenApiSpecForIntegration()
        .catch((e: unknown) => e);

      expect((error as ApplicationIntegrationError).code).toBe(
        ApplicationIntegrationErrorCode.INVALID_REQUEST,
      );
      expect((error as Error).message).toBe(
        'Integration name and triggers are required to generate an' +
          ' integration OpenAPI spec.',
      );
    });
  });

  describe('getOpenApiSpecForConnection', () => {
    it('rejects operations with no connection', async () => {
      const error = await createClient({entityOperations: {Issues: ['LIST']}})
        .getOpenApiSpecForConnection()
        .catch((e: unknown) => e);

      expect((error as ApplicationIntegrationError).code).toBe(
        ApplicationIntegrationErrorCode.INVALID_REQUEST,
      );
      expect((error as Error).message).toBe(
        'Connection name is required to generate a connection OpenAPI spec.',
      );
    });

    it('rejects a connection with no operations and no actions', async () => {
      const error = await createClient({connection: 'test-connection'})
        .getOpenApiSpecForConnection()
        .catch((e: unknown) => e);

      expect((error as ApplicationIntegrationError).code).toBe(
        ApplicationIntegrationErrorCode.INVALID_REQUEST,
      );
      expect((error as Error).message).toBe(
        'No entity operations or actions provided. Please provide at least' +
          ' one of them.',
      );
    });

    it('builds the list operation for a named entity operation', async () => {
      stubEntityMetadata(['LIST', 'GET']);

      const spec = await createClient({
        connection: 'test-connection',
        entityOperations: {Issues: ['LIST']},
      }).getOpenApiSpecForConnection('prefix', 'be careful');

      const path = pathFor(spec, 'list_Issues');
      expect(path).toBe(
        '/v2/projects/p/locations/us-central1/integrations/' +
          'ExecuteConnection:execute?triggerId=api_trigger/ExecuteConnection' +
          '#list_Issues',
      );
      expect(spec.paths[path].post['x-operation']).toBe('LIST_ENTITIES');
      expect(spec.paths[path].post['x-entity']).toBe('Issues');
      expect(spec.paths[path].post.operationId).toBe('prefix_list_Issues');
      expect(spec.paths[path].post.description).toContain('be careful');
      expect(spec.components.schemas['list_Issues_Request']).toBeDefined();
      expect(spec.components.schemas['connectorInputPayload_Issues']).toEqual({
        type: 'object',
        properties: {id: {type: 'integer'}},
      });
      expect(Object.keys(spec.paths)).toHaveLength(1);
    });

    it('falls back to every supported operation for an empty list', async () => {
      stubEntityMetadata(['LIST', 'GET', 'CREATE', 'UPDATE', 'DELETE']);

      const spec = await createClient({
        connection: 'test-connection',
        entityOperations: {Issues: []},
      }).getOpenApiSpecForConnection();

      expect(Object.keys(spec.paths)).toHaveLength(5);
      expect(spec.paths[pathFor(spec, 'get_Issues')].post['x-operation']).toBe(
        'GET_ENTITY',
      );
      expect(
        spec.paths[pathFor(spec, 'create_Issues')].post['x-operation'],
      ).toBe('CREATE_ENTITY');
      expect(
        spec.paths[pathFor(spec, 'update_Issues')].post['x-operation'],
      ).toBe('UPDATE_ENTITY');
      expect(
        spec.paths[pathFor(spec, 'delete_Issues')].post['x-operation'],
      ).toBe('DELETE_ENTITY');
      for (const operation of ['list', 'get', 'create', 'update', 'delete']) {
        expect(
          spec.components.schemas[`${operation}_Issues_Request`],
        ).toBeDefined();
      }
    });

    it('replaces ExecuteConnection in the path and the trigger id', async () => {
      stubEntityMetadata(['LIST']);

      const spec = await createClient({
        connection: 'test-connection',
        entityOperations: {Issues: ['LIST']},
        connectionTemplateOverride: 'MyRunner',
      }).getOpenApiSpecForConnection();

      expect(pathFor(spec, 'list_Issues')).toBe(
        '/v2/projects/p/locations/us-central1/integrations/' +
          'MyRunner:execute?triggerId=api_trigger/MyRunner#list_Issues',
      );
    });

    it('rejects an operation the connector does not support', async () => {
      stubEntityMetadata(['LIST']);

      const error = await createClient({
        connection: 'test-connection',
        entityOperations: {Issues: ['ARCHIVE']},
      })
        .getOpenApiSpecForConnection()
        .catch((e: unknown) => e);

      expect((error as ApplicationIntegrationError).code).toBe(
        ApplicationIntegrationErrorCode.INVALID_REQUEST,
      );
      expect((error as Error).message).toBe(
        'Invalid operation: archive for entity: Issues',
      );
    });

    it('builds an EXECUTE_ACTION path and strips spaces from the display name', async () => {
      stubActionMetadata('Custom Action');

      const spec = await createClient({
        connection: 'test-connection',
        actions: ['CustomAction'],
      }).getOpenApiSpecForConnection();

      const path = pathFor(spec, 'CustomAction');
      expect(spec.paths[path].post['x-operation']).toBe('EXECUTE_ACTION');
      expect(spec.paths[path].post['x-action']).toBe('CustomAction');
      expect(spec.components.schemas['CustomAction_Request']).toMatchObject({
        required: expect.arrayContaining(['connectorInputPayload']),
      });
      expect(
        spec.components.schemas['connectorInputPayload_CustomAction'],
      ).toEqual({type: 'object', properties: {q: {type: 'string'}}});
      expect(
        spec.components.schemas['connectorOutputPayload_CustomAction'],
      ).toEqual({type: 'object', properties: {r: {type: 'string'}}});
      expect(spec.components.schemas['CustomAction_Response']).toBeDefined();
    });

    it('builds an EXECUTE_QUERY path for ExecuteCustomQuery', async () => {
      stubActionMetadata('ExecuteCustomQuery');

      const spec = await createClient({
        connection: 'test-connection',
        actions: ['ExecuteCustomQuery'],
      }).getOpenApiSpecForConnection();

      const path = pathFor(spec, 'ExecuteCustomQuery');
      expect(spec.paths[path].post['x-operation']).toBe('EXECUTE_QUERY');
      expect(
        spec.components.schemas['ExecuteCustomQuery_Request'],
      ).toMatchObject({
        required: expect.arrayContaining(['query', 'timeout']),
      });
      // A custom query sends SQL, not a connector payload.
      expect(
        spec.components.schemas['connectorInputPayload_ExecuteCustomQuery'],
      ).toBeUndefined();
    });
  });
});
