/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ApiTransport} from '../../../../src/tools/application_integration_tool/clients/api_transport.js';
import {ConnectionsClient} from '../../../../src/tools/application_integration_tool/clients/connections_client.js';
import {parseServiceAccountCredential} from '../../../../src/utils/service_account_utils.js';

const getAccessToken = vi.fn();
const getProjectId = vi.fn();
const jwtConstructor = vi.fn();

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getClient() {
      return Promise.resolve({getAccessToken, quotaProjectId: undefined});
    }
    getProjectId() {
      return getProjectId();
    }
  },
  JWT: class {
    constructor(options: unknown) {
      jwtConstructor(options);
    }
    getAccessToken() {
      return getAccessToken();
    }
  },
}));

const CONNECTION_URL =
  'https://connectors.googleapis.com/v1/projects/test-project/locations/' +
  'us-central1/connections/test-connection';

/** A complete service account key file, as the parser requires. */
const SERVICE_ACCOUNT_KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'key-project',
  private_key_id: 'test-key-id',
  private_key: 'test-key',
  client_email: 'test@example.com',
  client_id: 'test-client-id',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/sa',
  universe_domain: 'googleapis.com',
});

function jsonResponse(body: unknown, init: {status?: number} = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  };
}

function createClient(serviceAccountJson?: string): ConnectionsClient {
  return new ConnectionsClient(
    {
      project: 'test-project',
      location: 'us-central1',
      connection: 'test-connection',
    },
    new ApiTransport(
      serviceAccountJson === undefined
        ? undefined
        : parseServiceAccountCredential(serviceAccountJson),
    ),
  );
}

describe('ConnectionsClient', () => {
  beforeEach(() => {
    getAccessToken.mockResolvedValue({token: 'test_token'});
    getProjectId.mockResolvedValue('adc-project');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  describe('getConnectionDetails', () => {
    it('reads the service directory of a connection without a host', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          name: 'test-connection',
          serviceDirectory: 'service-directory',
          authOverrideEnabled: true,
        }),
      );
      globalThis.fetch = fetchMock;

      const details = await createClient().getConnectionDetails();

      expect(details).toEqual({
        name: 'test-connection',
        serviceName: 'service-directory',
        host: '',
        authOverrideEnabled: true,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `${CONNECTION_URL}?view=BASIC`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test_token',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('reads the TLS service directory when a host is set', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          name: 'test-connection',
          serviceDirectory: 'service-directory',
          tlsServiceDirectory: 'tls-service-directory',
          host: 'test.host.com',
        }),
      );

      const details = await createClient().getConnectionDetails();

      expect(details).toEqual({
        name: 'test-connection',
        serviceName: 'tls-service-directory',
        host: 'test.host.com',
        authOverrideEnabled: false,
      });
    });

    it('defaults every missing field', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));

      expect(await createClient().getConnectionDetails()).toEqual({
        name: '',
        serviceName: '',
        host: '',
        authOverrideEnabled: false,
      });
    });

    it('reports an invalid project, location or connection on 404', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, {status: 404}));

      await expect(createClient().getConnectionDetails()).rejects.toThrow(
        new InputValidationError(
          'Invalid request. Please check the provided values of' +
            ' project(test-project), location(us-central1),' +
            ' connection(test-connection).',
        ),
      );
    });

    it('reports an invalid request on 400', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, {status: 400}));

      await expect(createClient().getConnectionDetails()).rejects.toThrow(
        InputValidationError,
      );
    });

    it('reports any other HTTP failure as a request error', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, {status: 500}));

      await expect(createClient().getConnectionDetails()).rejects.toThrow(
        'Request error: 500 Error',
      );
    });

    it('reports a transport failure as a request error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('socket closed'));

      await expect(createClient().getConnectionDetails()).rejects.toThrow(
        'Request error: socket closed',
      );
    });

    it('rejects a response body that is not a JSON object', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(['not', 'it']));

      await expect(createClient().getConnectionDetails()).rejects.toThrow(
        'Expected a JSON object from https://connectors.googleapis.com',
      );
    });

    it('rejects a response body that is not JSON at all', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      });

      await expect(createClient().getConnectionDetails()).rejects.toThrow(
        'Expected a JSON object from https://connectors.googleapis.com',
      );
    });
  });

  describe('getEntitySchemaAndOperations', () => {
    it('polls the operation and returns the schema and operations', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/abc'}))
        .mockResolvedValueOnce(
          jsonResponse({
            done: true,
            response: {
              jsonSchema: {type: 'object'},
              operations: ['LIST', 'GET', 42],
            },
          }),
        );

      const result =
        await createClient().getEntitySchemaAndOperations('Issues');

      expect(result).toEqual({
        schema: {type: 'object'},
        operations: ['LIST', 'GET'],
      });
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        1,
        `${CONNECTION_URL}/connectionSchemaMetadata:getEntityType?entityId=Issues`,
        expect.objectContaining({method: 'GET'}),
      );
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        'https://connectors.googleapis.com/v1/operations/abc',
        expect.objectContaining({method: 'GET'}),
      );
    });

    it('escapes an entity name that would otherwise change the query', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/abc'}))
        .mockResolvedValueOnce(jsonResponse({done: true}));

      await createClient().getEntitySchemaAndOperations('Is&sues#1');

      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        1,
        `${CONNECTION_URL}/connectionSchemaMetadata:getEntityType` +
          '?entityId=Is%26sues%231',
        expect.objectContaining({method: 'GET'}),
      );
    });

    it('defaults a schema and operations the operation omits', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/abc'}))
        .mockResolvedValueOnce(jsonResponse({done: true}));

      expect(
        await createClient().getEntitySchemaAndOperations('Issues'),
      ).toEqual({schema: {}, operations: []});
    });

    it('fails when the metadata call returns no operation name', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));

      await expect(
        createClient().getEntitySchemaAndOperations('Issues'),
      ).rejects.toThrow(
        'Failed to get entity schema and operations for entity: Issues',
      );
    });

    it('fails when the operation name is empty', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({name: ''}));

      await expect(
        createClient().getEntitySchemaAndOperations('Issues'),
      ).rejects.toThrow(
        'Failed to get entity schema and operations for entity: Issues',
      );
    });

    it('surfaces an API error', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, {status: 500}));

      await expect(
        createClient().getEntitySchemaAndOperations('Issues'),
      ).rejects.toThrow('Request error: 500 Error');
    });
  });

  describe('getActionSchema', () => {
    it('polls the operation and returns both schemas', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/action'}))
        .mockResolvedValueOnce(
          jsonResponse({
            done: true,
            response: {
              inputJsonSchema: {type: 'object'},
              outputJsonSchema: {type: 'string'},
              description: 'an action',
              displayName: 'Custom Action',
            },
          }),
        );

      expect(await createClient().getActionSchema('CustomAction')).toEqual({
        inputSchema: {type: 'object'},
        outputSchema: {type: 'string'},
        description: 'an action',
        displayName: 'Custom Action',
      });
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        1,
        `${CONNECTION_URL}/connectionSchemaMetadata:getAction?actionId=CustomAction`,
        expect.objectContaining({method: 'GET'}),
      );
    });

    it('escapes an action name that would otherwise change the query', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/action'}))
        .mockResolvedValueOnce(jsonResponse({done: true, response: {}}));

      await createClient().getActionSchema('Custom&Action#1');

      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        1,
        `${CONNECTION_URL}/connectionSchemaMetadata:getAction` +
          '?actionId=Custom%26Action%231',
        expect.objectContaining({method: 'GET'}),
      );
    });

    it('defaults the fields the operation omits', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/action'}))
        .mockResolvedValueOnce(jsonResponse({done: true, response: {}}));

      expect(await createClient().getActionSchema('CustomAction')).toEqual({
        inputSchema: {},
        outputSchema: {},
        description: '',
        displayName: '',
      });
    });

    it('fails when the metadata call returns no operation name', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));

      await expect(
        createClient().getActionSchema('CustomAction'),
      ).rejects.toThrow('Failed to get action schema for action: CustomAction');
    });

    it('surfaces an API error', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, {status: 500}));

      await expect(
        createClient().getActionSchema('CustomAction'),
      ).rejects.toThrow('Request error: 500 Error');
    });
  });

  describe('operation polling', () => {
    it('keeps polling until the operation reports done', async () => {
      vi.useFakeTimers();
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/abc'}))
        .mockResolvedValueOnce(jsonResponse({done: false}))
        .mockResolvedValueOnce(
          jsonResponse({done: true, response: {jsonSchema: {type: 'object'}}}),
        );

      const pending = createClient().getEntitySchemaAndOperations('Issues');
      await vi.advanceTimersByTimeAsync(1000);

      expect(await pending).toEqual({schema: {type: 'object'}, operations: []});
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('gives up on an operation that never completes', async () => {
      vi.useFakeTimers();
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/abc'}))
        .mockResolvedValue(jsonResponse({done: false}));

      const pending = createClient().getEntitySchemaAndOperations('Issues');
      const assertion = expect(pending).rejects.toThrow(
        'Operation operations/abc did not complete within 120000ms',
      );
      await vi.advanceTimersByTimeAsync(121000);

      await assertion;
    });
  });

  describe('credentials', () => {
    it('signs with a service account key when one is given', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));

      await createClient(SERVICE_ACCOUNT_KEY).getConnectionDetails();

      expect(jwtConstructor).toHaveBeenCalledWith({
        email: 'test@example.com',
        key: 'test-key',
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    });

    it('resolves the credentials once and reuses the client', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/abc'}))
        .mockResolvedValueOnce(jsonResponse({done: true, response: {}}));

      await createClient().getEntitySchemaAndOperations('Issues');

      expect(getAccessToken).toHaveBeenCalledTimes(2);
      expect(getProjectId).toHaveBeenCalledTimes(1);
    });

    it('reports unavailable credentials as a credentials error', async () => {
      globalThis.fetch = vi.fn();
      getAccessToken.mockRejectedValue(
        new Error('Could not load the default credentials'),
      );

      await expect(createClient().getConnectionDetails()).rejects.toThrow(
        'Credentials error: Could not load the default credentials',
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('reports a credential that yields no token', async () => {
      globalThis.fetch = vi.fn();
      getAccessToken.mockResolvedValue({token: null});

      await expect(createClient().getConnectionDetails()).rejects.toThrow(
        'Please provide a service account that has the required permissions' +
          ' to access the connection.',
      );
    });
  });
});
