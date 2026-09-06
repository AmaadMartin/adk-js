/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  SecretManagerClient,
  SecretManagerClientOptions,
  version,
} from '@google/adk';
import type {Credentials, GoogleAuthOptions} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/** The request options {@link SecretManagerClient} sends to the auth client. */
interface RequestOptions {
  url: string;
  headers: Record<string, string>;
}

/** The response shape the auth client resolves to for an `:access` call. */
interface AccessResponse {
  data: {payload?: {data?: string}};
}

const mocks = vi.hoisted(() => {
  const request = vi.fn<(options: RequestOptions) => Promise<AccessResponse>>();
  const getClient = vi.fn(() => Promise.resolve({request}));
  const googleAuthConstructor = vi.fn<(options: GoogleAuthOptions) => void>();
  const oauthConstructor = vi.fn<() => void>();
  const oauthSetCredentials = vi.fn<(credentials: Credentials) => void>();

  class FakeGoogleAuth {
    getClient = getClient;

    constructor(options: GoogleAuthOptions) {
      googleAuthConstructor(options);
    }
  }

  class FakeOAuth2Client {
    setCredentials = oauthSetCredentials;

    constructor() {
      oauthConstructor();
    }
  }

  return {
    FakeOAuth2Client,
    getClient,
    googleAuthConstructor,
    oauthConstructor,
    oauthSetCredentials,
    request,
    FakeGoogleAuth,
  };
});

vi.mock('google-auth-library', () => ({
  GoogleAuth: mocks.FakeGoogleAuth,
  OAuth2Client: mocks.FakeOAuth2Client,
}));

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const RESOURCE_NAME =
  'projects/test-project/secrets/test-secret/versions/latest';
const GLOBAL_URL = `https://secretmanager.googleapis.com/v1/${RESOURCE_NAME}:access`;
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'key-id',
  private_key: 'private-key',
  client_email: 'test@example.com',
};

/** Builds the value `AuthClient.request` resolves to for a base64 payload. */
function accessResponse(secret: string): AccessResponse {
  return {data: {payload: {data: Buffer.from(secret).toString('base64')}}};
}

/** Returns the options passed to the single recorded request. */
function recordedRequest(): RequestOptions {
  const call = mocks.request.mock.calls[0];
  expect(call).toBeDefined();
  return call[0];
}

describe('SecretManagerClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({request: mocks.request});
  });

  describe('constructor', () => {
    it('uses application default credentials', () => {
      new SecretManagerClient();

      expect(mocks.googleAuthConstructor).toHaveBeenCalledExactlyOnceWith({
        scopes: SCOPES,
      });
      expect(mocks.oauthConstructor).not.toHaveBeenCalled();
    });

    it('passes service account JSON as credentials', () => {
      new SecretManagerClient({
        serviceAccountJson: JSON.stringify(SERVICE_ACCOUNT),
      });

      expect(mocks.googleAuthConstructor).toHaveBeenCalledExactlyOnceWith({
        credentials: SERVICE_ACCOUNT,
        scopes: SCOPES,
      });
      expect(mocks.oauthConstructor).not.toHaveBeenCalled();
    });

    it('builds an OAuth2 client from an auth token', () => {
      new SecretManagerClient({authToken: 'test-token'});

      expect(mocks.oauthConstructor).toHaveBeenCalledOnce();
      expect(mocks.oauthSetCredentials).toHaveBeenCalledExactlyOnceWith({
        access_token: 'test-token',
      });
      expect(mocks.googleAuthConstructor).toHaveBeenCalledExactlyOnceWith({
        authClient: expect.any(mocks.FakeOAuth2Client),
      });
    });

    it('rejects service account JSON that does not parse', () => {
      expect(
        () => new SecretManagerClient({serviceAccountJson: 'invalid-json'}),
      ).toThrow(/Invalid service account JSON/);
      expect(mocks.googleAuthConstructor).not.toHaveBeenCalled();
    });

    it('rejects service account JSON that is not an object', () => {
      expect(
        () => new SecretManagerClient({serviceAccountJson: '123'}),
      ).toThrow('Invalid service account JSON: expected a JSON object.');
      expect(mocks.googleAuthConstructor).not.toHaveBeenCalled();
    });

    it('rejects a location that is not a location ID', () => {
      expect(() => new SecretManagerClient({location: 'evil.com/'})).toThrow(
        'Invalid location: evil.com/',
      );
    });

    it('rejects a location holding regular expression metacharacters', () => {
      expect(() => new SecretManagerClient({location: '$&'})).toThrow(
        'Invalid location: $&',
      );
    });

    it('rejects both service account JSON and an auth token', () => {
      expect(
        () =>
          new SecretManagerClient({
            serviceAccountJson: JSON.stringify(SERVICE_ACCOUNT),
            authToken: 'test-token',
          }),
      ).toThrow(
        "Must provide either 'serviceAccountJson' or 'authToken', not both.",
      );
      expect(mocks.googleAuthConstructor).not.toHaveBeenCalled();
    });

    it.each<[string, SecretManagerClientOptions]>([
      ['unparsable service account JSON', {serviceAccountJson: 'invalid-json'}],
      ['a service account JSON scalar', {serviceAccountJson: '123'}],
      ['a location that is not a location ID', {location: 'evil.com/'}],
      [
        'both credential sources',
        {serviceAccountJson: '{}', authToken: 'test-token'},
      ],
    ])('rejects %s with an InputValidationError', (_, options) => {
      expect(() => new SecretManagerClient(options)).toThrow(
        InputValidationError,
      );
    });
  });

  describe('getSecret', () => {
    it('decodes the base64 payload as UTF-8', async () => {
      mocks.request.mockResolvedValue(accessResponse('pässwörd-✓'));

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe('pässwörd-✓');
    });

    it('returns an empty string for an empty payload', async () => {
      mocks.request.mockResolvedValue(accessResponse(''));

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe('');
    });

    it('returns an empty string when the payload omits data', async () => {
      mocks.request.mockResolvedValue({data: {payload: {}}});

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe('');
    });

    it('returns an empty string when the response omits the payload', async () => {
      mocks.request.mockResolvedValue({data: {}});

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe('');
    });

    it('requests the global endpoint when no location is given', async () => {
      mocks.request.mockResolvedValue(accessResponse('secret-value'));

      const client = new SecretManagerClient();
      await client.getSecret(RESOURCE_NAME);

      expect(mocks.request).toHaveBeenCalledOnce();
      expect(recordedRequest().url).toBe(GLOBAL_URL);
    });

    it('requests the regional endpoint when a location is given', async () => {
      mocks.request.mockResolvedValue(accessResponse('secret-value'));

      const client = new SecretManagerClient({location: 'us-central1'});
      await client.getSecret(RESOURCE_NAME);

      expect(recordedRequest().url).toBe(
        `https://secretmanager.us-central1.rep.googleapis.com/v1/${RESOURCE_NAME}:access`,
      );
    });

    it('identifies itself with the ADK client labels', async () => {
      mocks.request.mockResolvedValue(accessResponse('secret-value'));

      const client = new SecretManagerClient();
      await client.getSecret(RESOURCE_NAME);

      const {headers} = recordedRequest();
      expect(headers['user-agent'].split(' ')[0]).toBe(`google-adk/${version}`);
      expect(headers['x-goog-api-client']).toBe(headers['user-agent']);
    });

    it('reuses one auth instance across calls', async () => {
      mocks.request.mockResolvedValue(accessResponse('secret-value'));

      const client = new SecretManagerClient();
      await client.getSecret(RESOURCE_NAME);
      await client.getSecret(RESOURCE_NAME);

      expect(mocks.googleAuthConstructor).toHaveBeenCalledOnce();
      expect(mocks.request).toHaveBeenCalledTimes(2);
    });

    it('reports that default credentials could not be resolved', async () => {
      mocks.getClient.mockRejectedValue(new Error('no ADC on this machine'));

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).rejects.toThrow(
        "'serviceAccountJson' or 'authToken' are both missing, and error " +
          'occurred while trying to use default credentials: no ADC on this machine',
      );
    });

    it('reports a default credential failure as an InputValidationError', async () => {
      mocks.getClient.mockRejectedValue(new Error('no ADC on this machine'));

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).rejects.toThrow(
        InputValidationError,
      );
    });

    it('propagates a credential failure for an explicit auth token', async () => {
      const authError = new Error('token rejected');
      mocks.getClient.mockRejectedValue(authError);

      const client = new SecretManagerClient({authToken: 'test-token'});

      await expect(client.getSecret(RESOURCE_NAME)).rejects.toBe(authError);
    });

    it('accepts a regional resource name', async () => {
      const regionalName =
        'projects/test-project/locations/us-central1/secrets/test-secret/versions/1';
      mocks.request.mockResolvedValue(accessResponse('secret-value'));

      const client = new SecretManagerClient({location: 'us-central1'});

      await expect(client.getSecret(regionalName)).resolves.toBe(
        'secret-value',
      );
      expect(recordedRequest().url).toBe(
        `https://secretmanager.us-central1.rep.googleapis.com/v1/${regionalName}:access`,
      );
    });

    it('encodes a fragment marker so the access suffix survives', async () => {
      mocks.request.mockResolvedValue(accessResponse('secret-value'));

      const client = new SecretManagerClient();
      await client.getSecret(`${RESOURCE_NAME}#`);

      expect(recordedRequest().url).toBe(
        `https://secretmanager.googleapis.com/v1/${RESOURCE_NAME}%23:access`,
      );
    });

    it('encodes a query marker in the resource name', async () => {
      mocks.request.mockResolvedValue(accessResponse('secret-value'));

      const client = new SecretManagerClient();
      await client.getSecret(
        'projects/test-project/secrets/test-secret/versions/1?alt=media',
      );

      expect(recordedRequest().url).toBe(
        'https://secretmanager.googleapis.com/v1/projects/test-project/' +
          'secrets/test-secret/versions/1%3Falt%3Dmedia:access',
      );
    });

    it('keeps the separators of a well-formed resource name', async () => {
      mocks.request.mockResolvedValue(accessResponse('secret-value'));

      const client = new SecretManagerClient();
      await client.getSecret(RESOURCE_NAME);

      expect(recordedRequest().url).toBe(GLOBAL_URL);
    });

    it('propagates API errors unchanged', async () => {
      const apiError = new Error('403 Permission denied on secret');
      mocks.request.mockRejectedValue(apiError);

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).rejects.toBe(apiError);
    });
  });
});
