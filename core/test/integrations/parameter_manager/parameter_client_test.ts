/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ParameterManagerClient, version} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => {
  const googleAuthConstructor = vi.fn();
  const setCredentials = vi.fn();
  const request = vi.fn();

  class FakeOAuth2Client {
    setCredentials = setCredentials;
  }

  class FakeGoogleAuth {
    constructor(options: unknown) {
      googleAuthConstructor(options);
    }

    async getClient() {
      return {request};
    }
  }

  return {
    FakeGoogleAuth,
    FakeOAuth2Client,
    googleAuthConstructor,
    request,
    setCredentials,
  };
});

vi.mock('google-auth-library', () => ({
  GoogleAuth: mocks.FakeGoogleAuth,
  OAuth2Client: mocks.FakeOAuth2Client,
}));

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const RESOURCE_NAME =
  'projects/test-project/locations/global/parameters/test-param/versions/latest';
const RENDER_URL = `https://parametermanager.googleapis.com/v1/${RESOURCE_NAME}:render`;
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'key-id',
  private_key: 'private-key',
  client_email: 'test@example.com',
};

function authOptions(): unknown {
  return mocks.googleAuthConstructor.mock.calls[0][0];
}

function respondWith(renderedPayload: string | undefined) {
  mocks.request.mockResolvedValue({data: {renderedPayload}});
}

describe('ParameterManagerClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('uses application default credentials when none are supplied', () => {
      new ParameterManagerClient();

      expect(mocks.googleAuthConstructor).toHaveBeenCalledTimes(1);
      expect(authOptions()).toEqual({scopes: SCOPES});
    });

    it('parses and forwards service account JSON', () => {
      new ParameterManagerClient({
        serviceAccountJson: JSON.stringify(SERVICE_ACCOUNT),
      });

      expect(authOptions()).toEqual({
        credentials: SERVICE_ACCOUNT,
        scopes: SCOPES,
      });
    });

    it('builds an OAuth2 client from an auth token', () => {
      new ParameterManagerClient({authToken: 'test-token'});

      expect(mocks.setCredentials).toHaveBeenCalledWith({
        access_token: 'test-token',
      });
      expect(authOptions()).toEqual({
        authClient: expect.any(mocks.FakeOAuth2Client),
        scopes: SCOPES,
      });
    });

    it('rejects malformed service account JSON without echoing it', () => {
      const secretish = '{"private_key": "not-json';

      expect(
        () => new ParameterManagerClient({serviceAccountJson: secretish}),
      ).toThrowError(/^Invalid service account JSON: /);
      expect(
        () => new ParameterManagerClient({serviceAccountJson: secretish}),
      ).not.toThrowError(/private_key/);
      expect(mocks.googleAuthConstructor).not.toHaveBeenCalled();
    });

    it('reports a non-Error parse failure', () => {
      vi.spyOn(JSON, 'parse').mockImplementation(() => {
        throw 'parser exploded';
      });

      expect(
        () => new ParameterManagerClient({serviceAccountJson: '{}'}),
      ).toThrowError('Invalid service account JSON: parser exploded');
    });

    it('rejects service account JSON combined with an auth token', () => {
      expect(
        () =>
          new ParameterManagerClient({
            serviceAccountJson: JSON.stringify(SERVICE_ACCOUNT),
            authToken: 'test-token',
          }),
      ).toThrowError(
        "Must provide either 'serviceAccountJson' or 'authToken', not both.",
      );
      expect(mocks.googleAuthConstructor).not.toHaveBeenCalled();
    });
  });

  describe('getParameter', () => {
    it('renders the parameter version and decodes the payload', async () => {
      respondWith(Buffer.from('parameter-value').toString('base64'));

      const value = await new ParameterManagerClient().getParameter(
        RESOURCE_NAME,
      );

      expect(value).toBe('parameter-value');
      expect(mocks.request).toHaveBeenCalledTimes(1);
      expect(mocks.request).toHaveBeenCalledWith({
        url: RENDER_URL,
        headers: {
          'x-goog-api-client': expect.stringContaining(`google-adk/${version}`),
        },
      });
    });

    it('decodes a multi-byte UTF-8 payload', async () => {
      respondWith(Buffer.from('pärameter-välue', 'utf-8').toString('base64'));

      const value = await new ParameterManagerClient().getParameter(
        RESOURCE_NAME,
      );

      expect(value).toBe('pärameter-välue');
    });

    it('returns an empty string when the payload is unset', async () => {
      respondWith(undefined);

      const value = await new ParameterManagerClient().getParameter(
        RESOURCE_NAME,
      );

      expect(value).toBe('');
    });

    it('targets the regional endpoint when a location is given', async () => {
      respondWith(Buffer.from('regional-value').toString('base64'));

      const value = await new ParameterManagerClient({
        location: 'us-central1',
      }).getParameter(RESOURCE_NAME);

      expect(value).toBe('regional-value');
      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: `https://parametermanager.us-central1.rep.googleapis.com/v1/${RESOURCE_NAME}:render`,
        }),
      );
    });

    it('percent-encodes resource name segments', async () => {
      respondWith(Buffer.from('encoded-value').toString('base64'));

      await new ParameterManagerClient().getParameter(
        'projects/p/locations/global/parameters/my param/versions/latest?alt=media',
      );

      expect(mocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url:
            'https://parametermanager.googleapis.com/v1/projects/p/locations/global/' +
            'parameters/my%20param/versions/latest%3Falt%3Dmedia:render',
        }),
      );
    });

    it('propagates API errors unchanged', async () => {
      const apiError = new Error('API error');
      mocks.request.mockRejectedValue(apiError);

      await expect(
        new ParameterManagerClient().getParameter(RESOURCE_NAME),
      ).rejects.toBe(apiError);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
