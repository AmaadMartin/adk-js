/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from google/adk-python at tag `v0.1.0`, module
 * `src/google/adk/tools/apihub_tool/clients/secret_client.py`. That tag ships
 * no test for the module, so the ported cases follow adk-python's current
 * suite, `tests/unittests/integrations/secret_manager/test_secret_client.py`.
 */

import {SecretManagerClient} from '@google/adk';
import type {JWTInput} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeAuthOptions {
  credentials?: JWTInput;
  scopes?: string[];
}

const authMock = vi.hoisted(() => ({
  /** The options every `new GoogleAuth(...)` was constructed with. */
  optionsSeen: [] as FakeAuthOptions[],
  /** How many times credentials were resolved. */
  getClientCalls: 0,
  /** The URLs `getRequestHeaders` was called with. */
  headerUrls: [] as Array<string | URL | undefined>,
  /** When set, credential resolution rejects with this error. */
  failure: undefined as Error | undefined,
  /** The token the resolved client mints. */
  token: 'resolved-token',
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn((options: FakeAuthOptions) => {
    authMock.optionsSeen.push(options);
    return {
      async getClient() {
        authMock.getClientCalls++;
        if (authMock.failure) {
          throw authMock.failure;
        }
        return {
          async getRequestHeaders(url?: string | URL) {
            authMock.headerUrls.push(url);
            return new Headers({Authorization: `Bearer ${authMock.token}`});
          },
        };
      },
    };
  }),
}));

const RESOURCE_NAME = 'projects/my-project/secrets/my-secret/versions/latest';
const ACCESS_URL = `https://secretmanager.googleapis.com/v1/${RESOURCE_NAME}:access`;

const SERVICE_ACCOUNT: JWTInput = {
  type: 'service_account',
  project_id: 'my-project',
  client_email: 'sa@my-project.iam.gserviceaccount.com',
};
const SERVICE_ACCOUNT_JSON = JSON.stringify(SERVICE_ACCOUNT);

const fetchMock = vi.fn<typeof fetch>();

/**
 * Answers every `fetch` with the Secret Manager body for `secret`. A `Response`
 * body can only be read once, so each call gets a new one.
 */
function respondWithSecret(secret: string): void {
  const data = Buffer.from(secret, 'utf-8').toString('base64');
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify({payload: {data}}), {status: 200}),
  );
}

/** Answers every `fetch` with an error status and body. */
function respondWithError(status: number, body: string): void {
  fetchMock.mockImplementation(async () => new Response(body, {status}));
}

/** Reads the `Authorization` header off a recorded `fetch` call. */
function authorizationOf(call: Parameters<typeof fetch>): string | null {
  return new Headers(call[1]?.headers).get('Authorization');
}

beforeEach(() => {
  authMock.optionsSeen.length = 0;
  authMock.getClientCalls = 0;
  authMock.headerUrls.length = 0;
  authMock.failure = undefined;
  authMock.token = 'resolved-token';
  fetchMock.mockReset();
  respondWithSecret('secret-value');
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TestSecretManagerClient', () => {
  it('test_init_with_default_credentials', async () => {
    const client = new SecretManagerClient();

    await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe('secret-value');
    // adk-python v0.1.0 calls `default_service_credential()` with no
    // arguments, so its `scopes=[...]` assertion is not ported here. The
    // scope this client sends is asserted below instead.
    expect(authMock.optionsSeen).toEqual([
      {credentials: undefined, scopes: expect.any(Array)},
    ]);
  });

  it('test_init_with_service_account_json', async () => {
    const client = new SecretManagerClient({
      serviceAccountJson: SERVICE_ACCOUNT_JSON,
    });

    await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe('secret-value');
    expect(authMock.optionsSeen[0].credentials).toEqual(SERVICE_ACCOUNT);
  });

  it('test_init_with_auth_token', async () => {
    // Divergence: adk-python builds a credentials object and refreshes it.
    // That branch instantiates an abstract class and cannot run as written,
    // so this port sends the token as a bearer header and never refreshes.
    const client = new SecretManagerClient({authToken: 'caller-token'});

    await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe('secret-value');
    expect(authorizationOf(fetchMock.mock.calls[0])).toBe(
      'Bearer caller-token',
    );
    expect(authMock.getClientCalls).toBe(0);
  });

  it('test_init_with_default_credentials_error', async () => {
    authMock.failure = new Error('no ADC');
    // Divergence: a TypeScript constructor cannot await, so the failure
    // surfaces from the first `getSecret` rather than from construction.
    const client = new SecretManagerClient();

    await expect(client.getSecret(RESOURCE_NAME)).rejects.toThrow(
      "'serviceAccountJson' or 'authToken' are both missing, and error " +
        'occurred while trying to use default credentials: no ADC',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('test_init_with_invalid_service_account_json', () => {
    expect(
      () => new SecretManagerClient({serviceAccountJson: 'not json'}),
    ).toThrow(/^Invalid service account JSON: /);
  });

  it('test_init_with_both_service_account_json_and_auth_token', () => {
    // Divergence: adk-python v0.1.0 silently prefers the service account,
    // because its token branch is an `elif`.
    expect(
      () =>
        new SecretManagerClient({
          serviceAccountJson: SERVICE_ACCOUNT_JSON,
          authToken: 'caller-token',
        }),
    ).toThrow(
      "Must provide either 'serviceAccountJson' or 'authToken', not both.",
    );
  });

  it('test_get_secret', async () => {
    respondWithSecret('my-secret-value');

    const client = new SecretManagerClient();

    await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe(
      'my-secret-value',
    );
    expect(fetchMock.mock.calls[0][0]).toBe(ACCESS_URL);
  });

  it('test_get_secret_error', async () => {
    respondWithError(404, 'Secret not found');

    const client = new SecretManagerClient();

    await expect(client.getSecret(RESOURCE_NAME)).rejects.toThrow(
      `Failed to access secret version '${RESOURCE_NAME}': ` +
        '404 Secret not found',
    );
  });
});

describe('SecretManagerClient', () => {
  it('reads the version resource with a plain GET', async () => {
    await new SecretManagerClient().getSecret(RESOURCE_NAME);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ACCESS_URL);
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it('requests the cloud-platform scope', async () => {
    await new SecretManagerClient().getSecret(RESOURCE_NAME);

    expect(authMock.optionsSeen[0].scopes).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
    ]);
    expect(authMock.headerUrls).toEqual([
      'https://secretmanager.googleapis.com',
    ]);
  });

  it('sends a bearer header for default credentials', async () => {
    authMock.token = 'adc-token';

    await new SecretManagerClient().getSecret(RESOURCE_NAME);

    expect(authorizationOf(fetchMock.mock.calls[0])).toBe('Bearer adc-token');
  });

  it('sends a bearer header for a service account keyfile', async () => {
    authMock.token = 'sa-token';

    await new SecretManagerClient({
      serviceAccountJson: SERVICE_ACCOUNT_JSON,
    }).getSecret(RESOURCE_NAME);

    expect(authorizationOf(fetchMock.mock.calls[0])).toBe('Bearer sa-token');
  });

  it('decodes a multi-byte UTF-8 payload', async () => {
    respondWithSecret('pässwörd-日本語-🔑');

    await expect(
      new SecretManagerClient().getSecret(RESOURCE_NAME),
    ).resolves.toBe('pässwörd-日本語-🔑');
  });

  it('resolves credentials once across two reads', async () => {
    const client = new SecretManagerClient();

    await client.getSecret(RESOURCE_NAME);
    await client.getSecret(RESOURCE_NAME);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authMock.getClientCalls).toBe(1);
  });

  it('mints a fresh header for every read', async () => {
    const client = new SecretManagerClient();

    await client.getSecret(RESOURCE_NAME);
    authMock.token = 'rotated-token';
    await client.getSecret(RESOURCE_NAME);

    expect(authorizationOf(fetchMock.mock.calls[1])).toBe(
      'Bearer rotated-token',
    );
  });

  it('reports the status and body of a denied read', async () => {
    respondWithError(403, 'Permission denied on secret');

    await expect(
      new SecretManagerClient().getSecret(RESOURCE_NAME),
    ).rejects.toThrow(
      `Failed to access secret version '${RESOURCE_NAME}': ` +
        '403 Permission denied on secret',
    );
  });

  it('propagates a service account failure unchanged', async () => {
    authMock.failure = new Error('invalid keyfile');

    await expect(
      new SecretManagerClient({
        serviceAccountJson: SERVICE_ACCOUNT_JSON,
      }).getSecret(RESOURCE_NAME),
    ).rejects.toThrow(/^invalid keyfile$/);
  });

  it('propagates a transport failure unchanged', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    await expect(
      new SecretManagerClient({authToken: 'caller-token'}).getSecret(
        RESOURCE_NAME,
      ),
    ).rejects.toThrow('socket hang up');
  });

  it('keeps the secret out of the error for a denied read', async () => {
    respondWithError(403, 'denied');

    const error = await new SecretManagerClient()
      .getSecret(RESOURCE_NAME)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(authMock.token);
  });
});
