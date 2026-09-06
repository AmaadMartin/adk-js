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
import {ApiTransport} from '../../../../src/tools/application_integration_tool/clients/api_transport.js';

const authConstructor = vi.fn();
const authGetAccessToken = vi.fn();
const authGetClient = vi.fn();
const authGetProjectId = vi.fn();

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(options: unknown) {
      authConstructor(options);
    }
    getAccessToken = authGetAccessToken;
    getClient = authGetClient;
    getProjectId = authGetProjectId;
  },
}));

const KEY_FILE = JSON.stringify({
  'type': 'service_account',
  'project_id': 'key-project',
  'private_key': 'private-key',
  'client_email': 'sa@example.com',
});

function jsonResponse(body: unknown) {
  return {ok: true, status: 200, statusText: 'OK', json: async () => body};
}

function errorResponse(status: number, statusText: string) {
  return {ok: false, status, statusText, json: async () => ({})};
}

function createTransport(serviceAccountJson?: string) {
  return new ApiTransport({
    project: 'p',
    location: 'us-central1',
    serviceAccountJson,
    resourceDescription: 'connection(c)',
  });
}

describe('ApiTransport', () => {
  beforeEach(() => {
    authGetAccessToken.mockResolvedValue('adc-token');
    authGetClient.mockResolvedValue({quotaProjectId: 'quota-project'});
    authGetProjectId.mockResolvedValue('adc-project');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('mints a token from an explicit service account key', async () => {
    const token = await createTransport(KEY_FILE).getAccessToken();

    expect(token).toBe('adc-token');
    expect(authConstructor).toHaveBeenCalledWith({
      credentials: {
        client_email: 'sa@example.com',
        private_key: 'private-key',
      },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  });

  it('mints a token from default credentials', async () => {
    expect(await createTransport().getAccessToken()).toBe('adc-token');
    expect(authConstructor).toHaveBeenCalledWith({
      credentials: undefined,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  });

  it('reuses the auth client across calls', async () => {
    const transport = createTransport(KEY_FILE);

    await transport.getAccessToken();
    await transport.getAccessToken();

    expect(authConstructor).toHaveBeenCalledTimes(1);
  });

  it('reports an unparsable key file as a credentials error', async () => {
    const transport = createTransport('{');

    const error = await transport.getAccessToken().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationIntegrationError);
    expect((error as ApplicationIntegrationError).code).toBe(
      ApplicationIntegrationErrorCode.CREDENTIALS,
    );
    expect((error as Error).message).toMatch(/not valid JSON/);
  });

  it('reports a failing token mint as a credentials error', async () => {
    authGetAccessToken.mockRejectedValue(new Error('no ADC'));

    const error = await createTransport()
      .getAccessToken()
      .catch((e: unknown) => e);

    expect((error as ApplicationIntegrationError).code).toBe(
      ApplicationIntegrationErrorCode.CREDENTIALS,
    );
    expect((error as Error).message).toBe('Credentials error: no ADC');
  });

  it('reports an empty token as a credentials error', async () => {
    authGetAccessToken.mockResolvedValue(null);

    const error = await createTransport()
      .getAccessToken()
      .catch((e: unknown) => e);

    expect((error as ApplicationIntegrationError).code).toBe(
      ApplicationIntegrationErrorCode.CREDENTIALS,
    );
    expect((error as Error).message).toMatch(/required permissions/);
  });

  it('reads the quota project from the default credential client', async () => {
    expect(await createTransport().getQuotaProjectId()).toBe('quota-project');
  });

  it('falls back to the ADC project when the client declares no quota project', async () => {
    authGetClient.mockResolvedValue({quotaProjectId: undefined});

    expect(await createTransport().getQuotaProjectId()).toBe('adc-project');
  });

  it('reads the quota project for an explicit service account too', async () => {
    authGetClient.mockResolvedValue({quotaProjectId: 'key-quota-project'});

    expect(await createTransport(KEY_FILE).getQuotaProjectId()).toBe(
      'key-quota-project',
    );
  });

  it('sends an authenticated GET', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ok: 1}));

    const body = await createTransport().get('https://api.example.com/thing');

    expect(body).toEqual({ok: 1});
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/thing',
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer adc-token',
        },
        body: undefined,
      },
    );
  });

  it('sends an authenticated POST with extra headers', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ok: 2}));

    const body = await createTransport().post(
      'https://api.example.com/thing',
      {a: 1},
      {'x-goog-user-project': 'quota-project'},
    );

    expect(body).toEqual({ok: 2});
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.example.com/thing',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer adc-token',
          'x-goog-user-project': 'quota-project',
        },
        body: '{"a":1}',
      },
    );
  });

  it.each([400, 404])(
    'maps HTTP %i to an invalid request naming the resource',
    async (status) => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(errorResponse(status, 'Bad Request'));

      const error = await createTransport()
        .get('https://api.example.com/thing')
        .catch((e: unknown) => e);

      expect((error as ApplicationIntegrationError).code).toBe(
        ApplicationIntegrationErrorCode.INVALID_REQUEST,
      );
      expect((error as Error).message).toBe(
        'Invalid request. Please check the provided values of project(p),' +
          ' location(us-central1), connection(c).',
      );
    },
  );

  it('maps any other failing status to a failed request', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(errorResponse(500, 'Internal Server Error'));

    const error = await createTransport()
      .get('https://api.example.com/thing')
      .catch((e: unknown) => e);

    expect((error as ApplicationIntegrationError).code).toBe(
      ApplicationIntegrationErrorCode.REQUEST_FAILED,
    );
    expect((error as Error).message).toBe(
      'Request error: 500 Internal Server Error',
    );
  });

  it('maps a transport failure to a failed request and keeps the cause', async () => {
    const cause = new Error('socket hang up');
    globalThis.fetch = vi.fn().mockRejectedValue(cause);

    const error = await createTransport()
      .get('https://api.example.com/thing')
      .catch((e: unknown) => e);

    expect((error as ApplicationIntegrationError).code).toBe(
      ApplicationIntegrationErrorCode.REQUEST_FAILED,
    );
    expect((error as Error).message).toBe('Request error: socket hang up');
    expect((error as Error).cause).toBe(cause);
  });
});
