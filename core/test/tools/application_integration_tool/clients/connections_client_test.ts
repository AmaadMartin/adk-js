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
import {ConnectionsClient} from '../../../../src/tools/application_integration_tool/clients/connections_client.js';

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    getAccessToken = async () => 'adc-token';
    getClient = async () => ({quotaProjectId: 'quota-project'});
    getProjectId = async () => 'adc-project';
  },
}));

const CONNECTION_URL =
  'https://connectors.googleapis.com/v1/projects/p/locations/us-central1' +
  '/connections/test-connection';

function jsonResponse(body: unknown) {
  return {ok: true, status: 200, statusText: 'OK', json: async () => body};
}

function errorResponse(status: number, statusText: string) {
  return {ok: false, status, statusText, json: async () => ({})};
}

function createClient() {
  return new ConnectionsClient({
    project: 'p',
    location: 'us-central1',
    connection: 'test-connection',
  });
}

describe('ConnectionsClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('getConnectionDetails', () => {
    it('reads the plain service directory when no host is set', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          name: 'projects/p/locations/us-central1/connections/test-connection',
          serviceDirectory: 'plain-directory',
          tlsServiceDirectory: 'tls-directory',
          host: '',
          authOverrideEnabled: true,
        }),
      );

      const details = await createClient().getConnectionDetails();

      expect(details).toEqual({
        name: 'projects/p/locations/us-central1/connections/test-connection',
        serviceName: 'plain-directory',
        host: '',
        authOverrideEnabled: true,
      });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${CONNECTION_URL}?view=BASIC`,
        expect.objectContaining({method: 'GET'}),
      );
    });

    it('reads the TLS service directory when a host is set', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        jsonResponse({
          name: 'connection-name',
          serviceDirectory: 'plain-directory',
          tlsServiceDirectory: 'tls-directory',
          host: 'my.host.example',
        }),
      );

      const details = await createClient().getConnectionDetails();

      expect(details.serviceName).toBe('tls-directory');
      expect(details.host).toBe('my.host.example');
    });

    it('treats a missing auth override as disabled', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({name: 'c'}));

      const details = await createClient().getConnectionDetails();

      expect(details).toEqual({
        name: 'c',
        serviceName: '',
        host: '',
        authOverrideEnabled: false,
      });
    });

    it('reports a 404 as an invalid request', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(errorResponse(404, 'Not Found'));

      const error = await createClient()
        .getConnectionDetails()
        .catch((e: unknown) => e);

      expect((error as ApplicationIntegrationError).code).toBe(
        ApplicationIntegrationErrorCode.INVALID_REQUEST,
      );
      expect((error as Error).message).toBe(
        'Invalid request. Please check the provided values of project(p),' +
          ' location(us-central1), connection(test-connection).',
      );
    });

    it('reports a 500 as a failed request', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(errorResponse(500, 'Internal Server Error'));

      const error = await createClient()
        .getConnectionDetails()
        .catch((e: unknown) => e);

      expect((error as ApplicationIntegrationError).code).toBe(
        ApplicationIntegrationErrorCode.REQUEST_FAILED,
      );
    });
  });

  describe('getEntitySchemaAndOperations', () => {
    it('polls the operation until it is done', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/123'}))
        .mockResolvedValueOnce(jsonResponse({done: false}))
        .mockResolvedValueOnce(
          jsonResponse({
            done: true,
            response: {
              jsonSchema: {type: 'object'},
              operations: ['LIST', 'GET'],
            },
          }),
        );

      const pending = createClient().getEntitySchemaAndOperations('Issues');
      await vi.runAllTimersAsync();

      expect(await pending).toEqual({
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
        'https://connectors.googleapis.com/v1/operations/123',
        expect.objectContaining({method: 'GET'}),
      );
    });

    it('defaults the schema and operations when the response omits them', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/123'}))
        .mockResolvedValueOnce(jsonResponse({done: true}));

      const pending = createClient().getEntitySchemaAndOperations('Issues');
      await vi.runAllTimersAsync();

      expect(await pending).toEqual({schema: {}, operations: []});
    });

    it('fails when the API names no operation to poll', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));

      const error = await createClient()
        .getEntitySchemaAndOperations('Issues')
        .catch((e: unknown) => e);

      expect((error as ApplicationIntegrationError).code).toBe(
        ApplicationIntegrationErrorCode.REQUEST_FAILED,
      );
      expect((error as Error).message).toBe(
        'Failed to get entity schema and operations for entity: Issues',
      );
    });

    it('gives up after the polling bound', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/123'}))
        .mockResolvedValue(jsonResponse({done: false}));

      const pending = createClient()
        .getEntitySchemaAndOperations('Issues')
        .catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const error = await pending;

      expect((error as ApplicationIntegrationError).code).toBe(
        ApplicationIntegrationErrorCode.REQUEST_FAILED,
      );
      expect((error as Error).message).toBe(
        'Operation operations/123 did not complete after 30 attempts.',
      );
      expect(globalThis.fetch).toHaveBeenCalledTimes(31);
    });

    it('escapes an entity name that needs encoding', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/123'}))
        .mockResolvedValueOnce(jsonResponse({done: true, response: {}}));

      const pending = createClient().getEntitySchemaAndOperations('My Issues');
      await vi.runAllTimersAsync();
      await pending;

      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        1,
        `${CONNECTION_URL}/connectionSchemaMetadata:getEntityType?entityId=My%20Issues`,
        expect.objectContaining({method: 'GET'}),
      );
    });
  });

  describe('getActionSchema', () => {
    it('returns the input and output schemas with the labels', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({name: 'operations/456'}))
        .mockResolvedValueOnce(
          jsonResponse({
            done: true,
            response: {
              inputJsonSchema: {type: 'object', properties: {q: {}}},
              outputJsonSchema: {type: 'object', properties: {r: {}}},
              description: 'runs a thing',
              displayName: 'Custom Action',
            },
          }),
        );

      const pending = createClient().getActionSchema('CustomAction');
      await vi.runAllTimersAsync();

      expect(await pending).toEqual({
        inputSchema: {type: 'object', properties: {q: {}}},
        outputSchema: {type: 'object', properties: {r: {}}},
        description: 'runs a thing',
        displayName: 'Custom Action',
      });
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        1,
        `${CONNECTION_URL}/connectionSchemaMetadata:getAction?actionId=CustomAction`,
        expect.objectContaining({method: 'GET'}),
      );
    });

    it('fails when the API names no operation to poll', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({name: ''}));

      const error = await createClient()
        .getActionSchema('CustomAction')
        .catch((e: unknown) => e);

      expect((error as Error).message).toBe(
        'Failed to get action schema for action: CustomAction',
      );
    });
  });
});
