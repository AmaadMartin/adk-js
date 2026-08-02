/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SecretManagerClient, version} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => {
  const secretManagerConstructor = vi.fn();
  const accessSecretVersion = vi.fn();
  const googleAuthConstructor = vi.fn();
  const jwtConstructor = vi.fn();
  const jwtFromJSON = vi.fn();
  const oauthConstructor = vi.fn();
  const oauthSetCredentials = vi.fn();

  class FakeSecretManagerServiceClient {
    accessSecretVersion = accessSecretVersion;

    constructor(options: unknown) {
      secretManagerConstructor(options);
    }
  }

  class FakeGoogleAuth {
    constructor(options: unknown) {
      googleAuthConstructor(options);
    }
  }

  class FakeJWT {
    fromJSON = jwtFromJSON;

    constructor(options: unknown) {
      jwtConstructor(options);
    }
  }

  class FakeOAuth2Client {
    setCredentials = oauthSetCredentials;

    constructor() {
      oauthConstructor();
    }
  }

  return {
    accessSecretVersion,
    FakeGoogleAuth,
    FakeJWT,
    FakeOAuth2Client,
    FakeSecretManagerServiceClient,
    googleAuthConstructor,
    jwtConstructor,
    jwtFromJSON,
    oauthConstructor,
    oauthSetCredentials,
    secretManagerConstructor,
  };
});

vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: mocks.FakeSecretManagerServiceClient,
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: mocks.FakeGoogleAuth,
  JWT: mocks.FakeJWT,
  OAuth2Client: mocks.FakeOAuth2Client,
}));

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const RESOURCE_NAME =
  'projects/test-project/secrets/test-secret/versions/latest';
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'key-id',
  private_key: 'private-key',
  client_email: 'test@example.com',
};

function lastClientOptions(): Record<string, unknown> {
  const call = mocks.secretManagerConstructor.mock.calls.at(-1);
  if (!call) {
    expect.fail('SecretManagerServiceClient was never constructed');
  }
  return call[0] as Record<string, unknown>;
}

describe('SecretManagerClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('uses application default credentials and the global endpoint', () => {
      new SecretManagerClient();

      expect(mocks.googleAuthConstructor).toHaveBeenCalledExactlyOnceWith({
        scopes: SCOPES,
      });
      expect(mocks.secretManagerConstructor).toHaveBeenCalledExactlyOnceWith({
        auth: expect.any(mocks.FakeGoogleAuth),
        libName: 'google-adk',
        libVersion: version,
      });
      expect(lastClientOptions()).not.toHaveProperty('apiEndpoint');
    });

    it('builds a JWT client from service account JSON', () => {
      new SecretManagerClient({
        serviceAccountJson: JSON.stringify(SERVICE_ACCOUNT),
      });

      expect(mocks.jwtConstructor).toHaveBeenCalledExactlyOnceWith({
        scopes: SCOPES,
      });
      expect(mocks.jwtFromJSON).toHaveBeenCalledExactlyOnceWith(
        SERVICE_ACCOUNT,
      );
      expect(mocks.googleAuthConstructor).toHaveBeenCalledExactlyOnceWith({
        authClient: expect.any(mocks.FakeJWT),
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
        scopes: SCOPES,
      });
      expect(mocks.jwtConstructor).not.toHaveBeenCalled();
    });

    it('targets the regional endpoint when a location is given', () => {
      new SecretManagerClient({location: 'us-central1'});

      expect(lastClientOptions()).toEqual({
        auth: expect.any(mocks.FakeGoogleAuth),
        libName: 'google-adk',
        libVersion: version,
        apiEndpoint: 'secretmanager.us-central1.rep.googleapis.com',
      });
    });

    it('rejects service account JSON that does not parse', () => {
      expect(
        () => new SecretManagerClient({serviceAccountJson: 'invalid-json'}),
      ).toThrow(/Invalid service account JSON/);
      expect(mocks.secretManagerConstructor).not.toHaveBeenCalled();
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
      expect(mocks.jwtConstructor).not.toHaveBeenCalled();
      expect(mocks.secretManagerConstructor).not.toHaveBeenCalled();
    });
  });

  describe('getSecret', () => {
    it('decodes a Buffer payload as UTF-8', async () => {
      mocks.accessSecretVersion.mockResolvedValue([
        {payload: {data: Buffer.from('secret-value')}},
      ]);

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe(
        'secret-value',
      );
      expect(mocks.accessSecretVersion).toHaveBeenCalledExactlyOnceWith({
        name: RESOURCE_NAME,
      });
    });

    it('decodes a Uint8Array payload as UTF-8', async () => {
      mocks.accessSecretVersion.mockResolvedValue([
        {payload: {data: new TextEncoder().encode('sécret-välue')}},
      ]);

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe(
        'sécret-välue',
      );
    });

    it('returns a string payload unchanged', async () => {
      mocks.accessSecretVersion.mockResolvedValue([
        {payload: {data: 'secret-value'}},
      ]);

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe(
        'secret-value',
      );
    });

    it('rejects when the response carries no payload', async () => {
      mocks.accessSecretVersion.mockResolvedValue([{}]);

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).rejects.toThrow(
        `Secret version ${RESOURCE_NAME} has no payload data.`,
      );
    });

    it('rejects when the payload data is null', async () => {
      mocks.accessSecretVersion.mockResolvedValue([{payload: {data: null}}]);

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).rejects.toThrow(
        `Secret version ${RESOURCE_NAME} has no payload data.`,
      );
    });

    it('propagates API errors unchanged', async () => {
      const apiError = new Error('Secret error');
      mocks.accessSecretVersion.mockRejectedValue(apiError);

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).rejects.toBe(apiError);
    });
  });
});
