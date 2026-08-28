/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {APIHubClient} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
// Not part of the package's public surface, so it is imported by path.
import {extractResourceName} from '../../../../src/tools/apihub_tool/clients/apihub_client.js';

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

      await expect(
        client().getApi(
          'projects/test-project/locations/us-central1/apis/api1',
        ),
      ).rejects.toThrow(
        'API Hub request failed with status 403: permission denied',
      );
    });

    it('gets an API', async () => {
      fetchMock.mockResolvedValueOnce(okResponse(API_DETAIL));

      const api = await client().getApi(
        'projects/test-project/locations/us-central1/apis/api1',
      );

      expect(api).toEqual(API_DETAIL);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'https://apihub.googleapis.com/v1/projects/test-project/locations/us-central1/apis/api1',
      );
      expect(init?.headers).toEqual(EXPECTED_HEADERS);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('gets an API version', async () => {
      fetchMock.mockResolvedValueOnce(okResponse(API_VERSION));

      const apiVersion = await client().getApiVersion(
        'projects/test-project/locations/us-central1/apis/api1/versions/v1',
      );

      expect(apiVersion).toEqual(API_VERSION);
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
      fetchMock.mockResolvedValueOnce(okResponse(API_DETAIL));

      await client().getApi(API_RESOURCE_NAME);

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
      fetchMock.mockResolvedValueOnce(okResponse(API_DETAIL));

      await new APIHubClient().getApi(API_RESOURCE_NAME);

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
      fetchMock.mockResolvedValueOnce(okResponse(API_DETAIL));

      await new APIHubClient({serviceAccountJson}).getApi(API_RESOURCE_NAME);

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
        new APIHubClient({serviceAccountJson: '{not json'}).getApi('api1'),
      ).rejects.toThrow(/^Invalid service account JSON: /);
      expect(mockGoogleAuth).not.toHaveBeenCalled();
    });

    it('reuses one GoogleAuth across calls', async () => {
      mockGetAccessToken.mockResolvedValue('adc_token');
      // A Response body reads once, so each call needs a fresh one.
      fetchMock.mockImplementation(() =>
        Promise.resolve(okResponse(API_DETAIL)),
      );
      const client = new APIHubClient();

      await client.getApi(API_RESOURCE_NAME);
      await client.getApi(API_RESOURCE_NAME);

      expect(mockGoogleAuth).toHaveBeenCalledTimes(1);
      expect(mockGetAccessToken).toHaveBeenCalledTimes(2);
    });

    it('rejects when the credentials yield no token', async () => {
      mockGetAccessToken.mockResolvedValue(null);

      await expect(new APIHubClient().getApi('api1')).rejects.toThrow(
        'Please provide a service account or an access token to API Hub client.',
      );
    });

    it('rejects when the credentials cannot be loaded', async () => {
      const cause = new Error('Could not load the default credentials');
      mockGetAccessToken.mockRejectedValue(cause);

      await expect(new APIHubClient().getApi('api1')).rejects.toThrow(
        'Please provide a service account or an access token to API Hub client.',
      );
      await expect(new APIHubClient().getApi('api1')).rejects.toHaveProperty(
        'cause',
        cause,
      );
    });
  });

  describe('extractResourceName', () => {
    it.each([
      [
        'projects/test-project/locations/us-central1/apis/api1',
        {
          apiResourceName:
            'projects/test-project/locations/us-central1/apis/api1',
          apiVersionResourceName: undefined,
          apiSpecResourceName: undefined,
        },
      ],
      [
        'projects/test-project/locations/us-central1/apis/api1/versions/v1',
        {
          apiResourceName:
            'projects/test-project/locations/us-central1/apis/api1',
          apiVersionResourceName:
            'projects/test-project/locations/us-central1/apis/api1/versions/v1',
          apiSpecResourceName: undefined,
        },
      ],
      [
        'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
        {
          apiResourceName:
            'projects/test-project/locations/us-central1/apis/api1',
          apiVersionResourceName:
            'projects/test-project/locations/us-central1/apis/api1/versions/v1',
          apiSpecResourceName:
            'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
        },
      ],
      [
        'https://console.cloud.google.com/apigee/api-hub/projects/test-project/locations/us-central1/apis/api1/versions/v1?project=test-project',
        {
          apiResourceName:
            'projects/test-project/locations/us-central1/apis/api1',
          apiVersionResourceName:
            'projects/test-project/locations/us-central1/apis/api1/versions/v1',
          apiSpecResourceName: undefined,
        },
      ],
      [
        'https://console.cloud.google.com/apigee/api-hub/projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1?project=test-project',
        {
          apiResourceName:
            'projects/test-project/locations/us-central1/apis/api1',
          apiVersionResourceName:
            'projects/test-project/locations/us-central1/apis/api1/versions/v1',
          apiSpecResourceName:
            'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
        },
      ],
      [
        '/projects/test-project/locations/us-central1/apis/api1/versions/v1',
        {
          apiResourceName:
            'projects/test-project/locations/us-central1/apis/api1',
          apiVersionResourceName:
            'projects/test-project/locations/us-central1/apis/api1/versions/v1',
          apiSpecResourceName: undefined,
        },
      ],
      [
        'projects/test-project/locations/us-central1/apis/api1/',
        {
          apiResourceName:
            'projects/test-project/locations/us-central1/apis/api1',
          apiVersionResourceName: undefined,
          apiSpecResourceName: undefined,
        },
      ],
      [
        'projects/test-project/locations/LOCATION/apis/api1/',
        {
          apiResourceName: 'projects/test-project/locations/LOCATION/apis/api1',
          apiVersionResourceName: undefined,
          apiSpecResourceName: undefined,
        },
      ],
      [
        'projects/p1/locations/l1/apis/a1/versions/v1/specs/s1',
        {
          apiResourceName: 'projects/p1/locations/l1/apis/a1',
          apiVersionResourceName:
            'projects/p1/locations/l1/apis/a1/versions/v1',
          apiSpecResourceName:
            'projects/p1/locations/l1/apis/a1/versions/v1/specs/s1',
        },
      ],
    ])('extracts the resource names of %s', (urlOrPath, expected) => {
      expect(extractResourceName(urlOrPath)).toEqual(expected);
    });

    it('reads the project from the query when the path has none', () => {
      expect(
        extractResourceName(
          'https://console.cloud.google.com/apigee/api-hub/locations/us-central1/apis/api1?project=test-project',
        ),
      ).toEqual({
        apiResourceName:
          'projects/test-project/locations/us-central1/apis/api1',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      });
    });

    it('ignores a spec id that comes without a version id', () => {
      expect(
        extractResourceName('projects/p1/locations/l1/apis/a1/specs/s1')
          .apiSpecResourceName,
      ).toBeUndefined();
    });

    it('falls back to the raw input when it does not parse as a URL', () => {
      expect(() => extractResourceName('http://[')).toThrow(
        "Project ID not found in URL or path in APIHubClient. Input path is 'http://['.",
      );
    });

    it.each([
      ['invalid-path', 'Project ID not found in URL or path in APIHubClient.'],
      [
        'projects/test-project',
        'Location not found in URL or path in APIHubClient.',
      ],
      [
        'projects/test-project/locations/us-central1',
        'API id not found in URL or path in APIHubClient.',
      ],
    ])('rejects %s', (urlOrPath, expectedMessage) => {
      expect(() => extractResourceName(urlOrPath)).toThrow(expectedMessage);
    });
  });
});
