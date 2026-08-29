/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {APIHubClient} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {mockGetAccessToken, mockGoogleAuth} = vi.hoisted(() => ({
  mockGetAccessToken: vi.fn<() => Promise<string | null>>(),
  mockGoogleAuth: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: mockGoogleAuth.mockImplementation(() => ({
    getAccessToken: mockGetAccessToken,
  })),
}));

const API_RESOURCE_NAME =
  'projects/test-project/locations/us-central1/apis/api1';
const VERSION_RESOURCE_NAME = `${API_RESOURCE_NAME}/versions/v1`;
const SPEC_RESOURCE_NAME = `${VERSION_RESOURCE_NAME}/specs/spec1`;
const API_DETAIL = {
  name: 'projects/test-project/locations/us-central1/apis/api1',
  versions: [
    'projects/test-project/locations/us-central1/apis/api1/versions/v1',
  ],
};
const API_VERSION = {
  name: 'projects/test-project/locations/us-central1/apis/api1/versions/v1',
  specs: [
    'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
  ],
};
const SPEC_CONTENT = {
  contents: Buffer.from('spec content', 'utf-8').toString('base64'),
};
const EXPECTED_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'Authorization': 'Bearer mocked_token',
};

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {status: 200});
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, {status});
}

describe('apihub_client', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    mockGoogleAuth.mockClear();
    mockGetAccessToken.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('APIHubClient with an access token', () => {
    function client(): APIHubClient {
      return new APIHubClient({accessToken: 'mocked_token'});
    }

    it('rejects when the request fails', async () => {
      fetchMock.mockResolvedValueOnce(errorResponse(403, 'permission denied'));

      await expect(client().getSpecContent(SPEC_RESOURCE_NAME)).rejects.toThrow(
        'API Hub request failed with status 403: permission denied',
      );
    });

    it('requests the API with the auth headers and a timeout signal', async () => {
      fetchMock
        .mockResolvedValueOnce(okResponse(API_DETAIL))
        .mockResolvedValueOnce(okResponse(API_VERSION))
        .mockResolvedValueOnce(okResponse(SPEC_CONTENT));

      await client().getSpecContent(API_RESOURCE_NAME);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://apihub.googleapis.com/v1/projects/test-project/locations/us-central1/apis/api1',
      );
      expect(init?.headers).toEqual(EXPECTED_HEADERS);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('requests the API version named by a version-level path', async () => {
      fetchMock
        .mockResolvedValueOnce(okResponse(API_VERSION))
        .mockResolvedValueOnce(okResponse(SPEC_CONTENT));

      await client().getSpecContent(VERSION_RESOURCE_NAME);

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://apihub.googleapis.com/v1/projects/test-project/locations/us-central1/apis/api1/versions/v1',
      );
      expect(fetchMock.mock.calls[0][1]?.headers).toEqual(EXPECTED_HEADERS);
    });

    it('gets the spec named by a spec-level path with one request', async () => {
      fetchMock.mockResolvedValueOnce(okResponse(SPEC_CONTENT));

      const content = await client().getSpecContent(
        'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
      );

      expect(content).toBe('spec content');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://apihub.googleapis.com/v1/projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1:contents',
      );
    });

    it('resolves the first spec of a version-level path', async () => {
      fetchMock
        .mockResolvedValueOnce(okResponse(API_VERSION))
        .mockResolvedValueOnce(okResponse(SPEC_CONTENT));

      const content = await client().getSpecContent(
        'projects/test-project/locations/us-central1/apis/api1/versions/v1',
      );

      expect(content).toBe('spec content');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('resolves the first spec of an API-level path', async () => {
      fetchMock
        .mockResolvedValueOnce(okResponse(API_DETAIL))
        .mockResolvedValueOnce(okResponse(API_VERSION))
        .mockResolvedValueOnce(okResponse(SPEC_CONTENT));

      const content = await client().getSpecContent(
        'projects/test-project/locations/us-central1/apis/api1',
      );

      expect(content).toBe('spec content');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('returns an empty string when the spec has no content', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({contents: ''}));

      const content = await client().getSpecContent(
        'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
      );

      expect(content).toBe('');
    });

    it('returns an empty string when the spec omits the contents field', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({}));

      const content = await client().getSpecContent(
        'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
      );

      expect(content).toBe('');
    });

    it('rejects when the API lists no versions field', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({}));

      await expect(
        client().getSpecContent(
          'projects/test-project/locations/us-central1/apis/api1',
        ),
      ).rejects.toThrow(
        'No versions found in API Hub resource: projects/test-project/locations/us-central1/apis/api1',
      );
    });

    it('rejects when the API has no versions', async () => {
      fetchMock.mockResolvedValueOnce(okResponse({versions: []}));

      await expect(
        client().getSpecContent(
          'projects/test-project/locations/us-central1/apis/api1',
        ),
      ).rejects.toThrow(
        'No versions found in API Hub resource: projects/test-project/locations/us-central1/apis/api1',
      );
    });

    it('rejects when the version lists no specs field', async () => {
      fetchMock
        .mockResolvedValueOnce(okResponse(API_DETAIL))
        .mockResolvedValueOnce(okResponse({}));

      await expect(
        client().getSpecContent(
          'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        ),
      ).rejects.toThrow(
        'No specs found in API Hub version: projects/test-project/locations/us-central1/apis/api1/versions/v1',
      );
    });

    it('rejects when the version has no specs', async () => {
      fetchMock
        .mockResolvedValueOnce(okResponse(API_DETAIL))
        .mockResolvedValueOnce(okResponse({specs: []}));

      await expect(
        client().getSpecContent(
          'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        ),
      ).rejects.toThrow(
        'No specs found in API Hub version: projects/test-project/locations/us-central1/apis/api1/versions/v1',
      );
    });

    it('rejects a path that names no project', async () => {
      await expect(client().getSpecContent('invalid-path')).rejects.toThrow(
        "Project ID not found in URL or path in APIHubClient. Input path is 'invalid-path'.",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never builds a GoogleAuth', async () => {
      fetchMock.mockResolvedValueOnce(okResponse(SPEC_CONTENT));

      await client().getSpecContent(SPEC_RESOURCE_NAME);

      expect(mockGoogleAuth).not.toHaveBeenCalled();
    });
  });

  describe('APIHubClient credentials', () => {
    const serviceAccountJson = JSON.stringify({
      type: 'service_account',
      project_id: 'test',
      token_uri: 'test.com',
      client_email: 'test@example.com',
      private_key: '1234',
    });

    it('mints a token from Application Default Credentials', async () => {
      mockGetAccessToken.mockResolvedValue('adc_token');
      fetchMock.mockResolvedValueOnce(okResponse(SPEC_CONTENT));

      await new APIHubClient().getSpecContent(SPEC_RESOURCE_NAME);

      expect(mockGoogleAuth).toHaveBeenCalledWith({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
        'accept': 'application/json, text/plain, */*',
        'Authorization': 'Bearer adc_token',
      });
    });

    it('mints a token from the service account key', async () => {
      mockGetAccessToken.mockResolvedValue('sa_token');
      fetchMock.mockResolvedValueOnce(okResponse(SPEC_CONTENT));

      await new APIHubClient({serviceAccountJson}).getSpecContent(
        SPEC_RESOURCE_NAME,
      );

      expect(mockGoogleAuth).toHaveBeenCalledWith({
        credentials: JSON.parse(serviceAccountJson),
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      expect(fetchMock.mock.calls[0][1]?.headers).toEqual({
        'accept': 'application/json, text/plain, */*',
        'Authorization': 'Bearer sa_token',
      });
    });

    it('rejects a malformed service account key', async () => {
      await expect(
        new APIHubClient({serviceAccountJson: '{not json'}).getSpecContent(
          SPEC_RESOURCE_NAME,
        ),
      ).rejects.toThrow(/^Invalid service account JSON: /);
      expect(mockGoogleAuth).not.toHaveBeenCalled();
    });

    it('reuses one GoogleAuth across calls', async () => {
      mockGetAccessToken.mockResolvedValue('adc_token');
      // A Response body reads once, so each call needs a fresh one.
      fetchMock.mockImplementation(() =>
        Promise.resolve(okResponse(SPEC_CONTENT)),
      );
      const client = new APIHubClient();

      await client.getSpecContent(SPEC_RESOURCE_NAME);
      await client.getSpecContent(SPEC_RESOURCE_NAME);

      expect(mockGoogleAuth).toHaveBeenCalledTimes(1);
      expect(mockGetAccessToken).toHaveBeenCalledTimes(2);
    });

    it('rejects when the credentials yield no token', async () => {
      mockGetAccessToken.mockResolvedValue(null);

      await expect(
        new APIHubClient().getSpecContent(SPEC_RESOURCE_NAME),
      ).rejects.toThrow(
        'Please provide a service account or an access token to API Hub client.',
      );
    });

    it('rejects when the credentials cannot be loaded', async () => {
      const cause = new Error('Could not load the default credentials');
      mockGetAccessToken.mockRejectedValue(cause);

      await expect(
        new APIHubClient().getSpecContent(SPEC_RESOURCE_NAME),
      ).rejects.toThrow(
        'Please provide a service account or an access token to API Hub client.',
      );
      await expect(
        new APIHubClient().getSpecContent(SPEC_RESOURCE_NAME),
      ).rejects.toHaveProperty('cause', cause);
    });
  });
});
