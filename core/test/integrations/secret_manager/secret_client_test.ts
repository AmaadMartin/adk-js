/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SecretManagerClient, version} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => {
  const request = vi.fn();
  const googleAuthConstructor = vi.fn();
  const jwtConstructor = vi.fn();
  const jwtFromJSON = vi.fn();
  const oauthConstructor = vi.fn();
  const oauthSetCredentials = vi.fn();

  class FakeGoogleAuth {
    constructor(options: unknown) {
      googleAuthConstructor(options);
    }

    getClient() {
      return Promise.resolve({request});
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
    FakeGoogleAuth,
    FakeJWT,
    FakeOAuth2Client,
    googleAuthConstructor,
    jwtConstructor,
    jwtFromJSON,
    oauthConstructor,
    oauthSetCredentials,
    request,
  };
});

vi.mock('google-auth-library', () => ({
  GoogleAuth: mocks.FakeGoogleAuth,
  JWT: mocks.FakeJWT,
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

/** Builds the shape `AuthClient.request` resolves to for a base64 payload. */
function accessResponse(secret: string) {
  return {data: {payload: {data: Buffer.from(secret).toString('base64')}}};
}

describe('SecretManagerClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('uses application default credentials', () => {
      new SecretManagerClient();

      expect(mocks.googleAuthConstructor).toHaveBeenCalledExactlyOnceWith({
        scopes: SCOPES,
      });
      expect(mocks.jwtConstructor).not.toHaveBeenCalled();
      expect(mocks.oauthConstructor).not.toHaveBeenCalled();
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

    it('rejects service account JSON that does not parse', () => {
      expect(
        () => new SecretManagerClient({serviceAccountJson: 'invalid-json'}),
      ).toThrow(/Invalid service account JSON/);
      expect(mocks.googleAuthConstructor).not.toHaveBeenCalled();
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
      expect(mocks.googleAuthConstructor).not.toHaveBeenCalled();
    });
  });

  describe('getSecret', () => {
    it('decodes the base64 payload as UTF-8', async () => {
      mocks.request.mockResolvedValue(accessResponse('sécret-välue'));

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe(
        'sécret-välue',
      );
    });

    it('requests the global endpoint and identifies itself by version', async () => {
      mocks.request.mockResolvedValue(accessResponse('secret-value'));

      const client = new SecretManagerClient();
      await client.getSecret(RESOURCE_NAME);

      expect(mocks.request).toHaveBeenCalledExactlyOnceWith({
        url: GLOBAL_URL,
        headers: {'User-Agent': `google-adk/${version}`},
      });
    });

    it('requests the regional endpoint when a location is given', async () => {
      mocks.request.mockResolvedValue(accessResponse('secret-value'));

      const client = new SecretManagerClient({location: 'us-central1'});
      await client.getSecret(RESOURCE_NAME);

      expect(mocks.request).toHaveBeenCalledExactlyOnceWith({
        url: `https://secretmanager.us-central1.rep.googleapis.com/v1/${RESOURCE_NAME}:access`,
        headers: {'User-Agent': `google-adk/${version}`},
      });
    });

    it('returns an empty string for an empty secret', async () => {
      mocks.request.mockResolvedValue(accessResponse(''));

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).resolves.toBe('');
    });

    it('rejects when the response carries no payload', async () => {
      mocks.request.mockResolvedValue({data: {}});

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).rejects.toThrow(
        `Secret version ${RESOURCE_NAME} has no payload data.`,
      );
    });

    it('rejects when the payload data is null', async () => {
      mocks.request.mockResolvedValue({data: {payload: {data: null}}});

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).rejects.toThrow(
        `Secret version ${RESOURCE_NAME} has no payload data.`,
      );
    });

    it('propagates API errors unchanged', async () => {
      const apiError = new Error('Secret error');
      mocks.request.mockRejectedValue(apiError);

      const client = new SecretManagerClient();

      await expect(client.getSecret(RESOURCE_NAME)).rejects.toBe(apiError);
    });
  });
});
