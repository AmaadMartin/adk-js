/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {APIHubClient} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';
import {Buffer} from 'node:buffer';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {
  ApiHubResourceNames,
  extractResourceName,
} from '../../../../src/tools/apihub_tool/clients/apihub_client.js';

let adcToken: string | null = 'adc_token';
let getClientRejects = false;

vi.mock('google-auth-library', () => {
  return {
    GoogleAuth: vi.fn().mockImplementation(() => {
      return {
        getClient: vi.fn().mockImplementation(() => {
          if (getClientRejects) {
            return Promise.reject(
              new Error('Could not load the default credentials'),
            );
          }
          return Promise.resolve({
            getAccessToken: vi.fn().mockResolvedValue({token: adcToken}),
          });
        }),
      };
    }),
  };
});

const ROOT = 'https://apihub.googleapis.com/v1';
const PROJECT = 'test-project';
const LOCATION = 'us-central1';
const API_NAME = `projects/${PROJECT}/locations/${LOCATION}/apis/api1`;
const VERSION_NAME = `${API_NAME}/versions/v1`;
const SPEC_NAME = `${VERSION_NAME}/specs/spec1`;

const MOCK_API_LIST = {
  apis: [
    {name: API_NAME},
    {name: `projects/${PROJECT}/locations/${LOCATION}/apis/api2`},
  ],
};
const MOCK_API_DETAIL = {name: API_NAME, versions: [VERSION_NAME]};
const MOCK_API_VERSION = {name: VERSION_NAME, specs: [SPEC_NAME]};
const MOCK_SPEC_CONTENT = {
  contents: Buffer.from('spec content').toString('base64'),
};

const AUTHORIZED_GET = {
  method: 'GET',
  headers: {
    'accept': 'application/json, text/plain, */*',
    'Authorization': 'Bearer mocked_token',
  },
};

const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'test',
  token_uri: 'test.com',
  client_email: 'test@example.com',
  private_key: '1234',
});

const CLOUD_PLATFORM_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

/** Resolves every call to a fresh response, since a body is readable once. */
function respondWith(fetchMock: Mock<typeof fetch>, body: unknown): void {
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(body)));
}

/** Returns the rejection of a promise, or undefined when it resolves. */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('apihub_client', () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    adcToken = 'adc_token';
    getClientRejects = false;
    vi.mocked(GoogleAuth).mockClear();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('extractResourceName', () => {
    it.each<[string, ApiHubResourceNames]>([
      [
        `projects/${PROJECT}/locations/${LOCATION}/apis/api1`,
        {apiResourceName: API_NAME},
      ],
      [
        `projects/${PROJECT}/locations/${LOCATION}/apis/api1/versions/v1`,
        {apiResourceName: API_NAME, apiVersionResourceName: VERSION_NAME},
      ],
      [
        `projects/${PROJECT}/locations/${LOCATION}/apis/api1/versions/v1/specs/spec1`,
        {
          apiResourceName: API_NAME,
          apiVersionResourceName: VERSION_NAME,
          apiSpecResourceName: SPEC_NAME,
        },
      ],
      [
        `https://console.cloud.google.com/apigee/api-hub/projects/${PROJECT}/locations/${LOCATION}/apis/api1/versions/v1?project=${PROJECT}`,
        {apiResourceName: API_NAME, apiVersionResourceName: VERSION_NAME},
      ],
      [
        `https://console.cloud.google.com/apigee/api-hub/projects/${PROJECT}/locations/${LOCATION}/apis/api1/versions/v1/specs/spec1?project=${PROJECT}`,
        {
          apiResourceName: API_NAME,
          apiVersionResourceName: VERSION_NAME,
          apiSpecResourceName: SPEC_NAME,
        },
      ],
      [
        `/projects/${PROJECT}/locations/${LOCATION}/apis/api1/versions/v1`,
        {apiResourceName: API_NAME, apiVersionResourceName: VERSION_NAME},
      ],
      [
        `projects/${PROJECT}/locations/${LOCATION}/apis/api1/`,
        {apiResourceName: API_NAME},
      ],
      [
        `projects/${PROJECT}/locations/LOCATION/apis/api1/`,
        {apiResourceName: `projects/${PROJECT}/locations/LOCATION/apis/api1`},
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
      [
        `https://console.cloud.google.com/apigee/api-hub/locations/${LOCATION}/apis/api1?project=q-project`,
        {
          apiResourceName: `projects/q-project/locations/${LOCATION}/apis/api1`,
        },
      ],
      [
        `projects/${PROJECT}/locations/${LOCATION}/apis/api-hub/versions/v1`,
        {
          apiResourceName: `projects/${PROJECT}/locations/${LOCATION}/apis/api-hub`,
          apiVersionResourceName: `projects/${PROJECT}/locations/${LOCATION}/apis/api-hub/versions/v1`,
        },
      ],
    ])('should extract the resource names from %s', (input, expected) => {
      expect(extractResourceName(input)).toEqual(expected);
    });
  });

  describe('extractResourceName with an incomplete path', () => {
    it.each([
      [
        'invalid-path',
        "Project ID not found in URL or path in APIHubClient. Input path is 'invalid-path'. Please make sure there is either '/projects/PROJECT_ID' in the path or 'project=PROJECT_ID' query param in the input.",
      ],
      [
        'projects/test-project',
        "Location not found in URL or path in APIHubClient. Input path is 'projects/test-project'. Please make sure there is either '/location/LOCATION_ID' in the path.",
      ],
      [
        'projects/test-project/locations/us-central1',
        "API id not found in URL or path in APIHubClient. Input path is 'projects/test-project/locations/us-central1'. Please make sure there is either '/apis/API_ID' in the path.",
      ],
    ])('should reject %s', (input, message) => {
      expect(() => extractResourceName(input)).toThrow(message);
    });
  });

  describe('APIHubClient HTTP surface', () => {
    let client: APIHubClient;

    beforeEach(() => {
      client = new APIHubClient({accessToken: 'mocked_token'});
    });

    it('should list the APIs of a project and location', async () => {
      respondWith(fetchMock, MOCK_API_LIST);

      expect(await client.listApis(PROJECT, LOCATION)).toEqual(
        MOCK_API_LIST.apis,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `${ROOT}/projects/${PROJECT}/locations/${LOCATION}/apis`,
        expect.objectContaining(AUTHORIZED_GET),
      );
    });

    it('should return an empty list when the response has no APIs', async () => {
      respondWith(fetchMock, {apis: []});
      expect(await client.listApis(PROJECT, LOCATION)).toEqual([]);

      respondWith(fetchMock, {});
      expect(await client.listApis(PROJECT, LOCATION)).toEqual([]);
    });

    it('should get an API by resource name', async () => {
      respondWith(fetchMock, MOCK_API_DETAIL);

      expect(await client.getApi(API_NAME)).toEqual(MOCK_API_DETAIL);
      expect(fetchMock).toHaveBeenCalledWith(
        `${ROOT}/${API_NAME}`,
        expect.objectContaining(AUTHORIZED_GET),
      );
    });

    it('should get an API version by resource name', async () => {
      respondWith(fetchMock, MOCK_API_VERSION);

      expect(await client.getApiVersion(VERSION_NAME)).toEqual(
        MOCK_API_VERSION,
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `${ROOT}/${VERSION_NAME}`,
        expect.objectContaining(AUTHORIZED_GET),
      );
    });

    it('should bound every request with an abort signal', async () => {
      respondWith(fetchMock, MOCK_API_DETAIL);

      await client.getApi(API_NAME);

      expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it.each<[string, () => Promise<unknown>]>([
      ['listApis', () => client.listApis(PROJECT, LOCATION)],
      ['getApi', () => client.getApi(API_NAME)],
      ['getApiVersion', () => client.getApiVersion(VERSION_NAME)],
      ['getSpecContent', () => client.getSpecContent(SPEC_NAME)],
    ])('should surface a non-2xx response from %s', async (_name, call) => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response('forbidden', {status: 403})),
      );

      await expect(call()).rejects.toThrow(
        'API Hub request failed with status 403: forbidden',
      );
    });
  });

  describe('APIHubClient.getSpecContent resolution', () => {
    let client: APIHubClient;

    beforeEach(() => {
      client = new APIHubClient({accessToken: 'mocked_token'});
    });

    it('should fetch only the contents for a spec-level name', async () => {
      respondWith(fetchMock, MOCK_SPEC_CONTENT);

      expect(await client.getSpecContent(SPEC_NAME)).toBe('spec content');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `${ROOT}/${SPEC_NAME}:contents`,
        expect.objectContaining(AUTHORIZED_GET),
      );
    });

    it('should resolve the first spec for a version-level name', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            ...MOCK_API_VERSION,
            specs: [SPEC_NAME, `${VERSION_NAME}/specs/spec2`],
          }),
        )
        .mockResolvedValueOnce(jsonResponse(MOCK_SPEC_CONTENT));

      expect(await client.getSpecContent(VERSION_NAME)).toBe('spec content');
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        `${ROOT}/${VERSION_NAME}`,
        `${ROOT}/${SPEC_NAME}:contents`,
      ]);
    });

    it('should resolve the first version and spec for an API-level name', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            ...MOCK_API_DETAIL,
            versions: [VERSION_NAME, `${API_NAME}/versions/v2`],
          }),
        )
        .mockResolvedValueOnce(jsonResponse(MOCK_API_VERSION))
        .mockResolvedValueOnce(jsonResponse(MOCK_SPEC_CONTENT));

      expect(await client.getSpecContent(API_NAME)).toBe('spec content');
      expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
        `${ROOT}/${API_NAME}`,
        `${ROOT}/${VERSION_NAME}`,
        `${ROOT}/${SPEC_NAME}:contents`,
      ]);
    });

    it.each<[string, object]>([
      ['empty', {contents: ''}],
      ['absent', {}],
    ])(
      'should return an empty string when the contents are %s',
      async (_name, body) => {
        respondWith(fetchMock, body);

        expect(await client.getSpecContent(SPEC_NAME)).toBe('');
      },
    );

    it.each<[string, object]>([
      ['empty', {name: API_NAME, versions: []}],
      ['absent', {name: API_NAME}],
    ])('should reject when the API versions are %s', async (_name, body) => {
      respondWith(fetchMock, body);

      await expect(client.getSpecContent(API_NAME)).rejects.toThrow(
        `No versions found in API Hub resource: ${API_NAME}`,
      );
    });

    it.each<[string, object]>([
      ['empty', {name: VERSION_NAME, specs: []}],
      ['absent', {name: VERSION_NAME}],
    ])('should reject when the version specs are %s', async (_name, body) => {
      respondWith(fetchMock, body);

      await expect(client.getSpecContent(VERSION_NAME)).rejects.toThrow(
        `No specs found in API Hub version: ${VERSION_NAME}`,
      );
    });

    it('should reject an invalid path without issuing a request', async () => {
      await expect(client.getSpecContent('invalid-path')).rejects.toThrow(
        "Project ID not found in URL or path in APIHubClient. Input path is 'invalid-path'.",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('APIHubClient credentials', () => {
    beforeEach(() => {
      respondWith(fetchMock, MOCK_API_DETAIL);
    });

    it('should prefer an explicit access token over a service account', async () => {
      const client = new APIHubClient({
        accessToken: 'mocked_token',
        serviceAccountJson: SERVICE_ACCOUNT_JSON,
      });

      await client.getApi(API_NAME);

      expect(GoogleAuth).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        `${ROOT}/${API_NAME}`,
        expect.objectContaining(AUTHORIZED_GET),
      );
    });

    it('should authenticate with a configured service account', async () => {
      adcToken = 'service_account_token';
      const client = new APIHubClient({
        serviceAccountJson: SERVICE_ACCOUNT_JSON,
      });

      await client.getApi(API_NAME);

      expect(GoogleAuth).toHaveBeenCalledWith({
        credentials: JSON.parse(SERVICE_ACCOUNT_JSON),
        scopes: CLOUD_PLATFORM_SCOPES,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        `${ROOT}/${API_NAME}`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer service_account_token',
          }),
        }),
      );
    });

    it('should fall back to application default credentials', async () => {
      const client = new APIHubClient();

      await client.getApi(API_NAME);

      expect(GoogleAuth).toHaveBeenCalledWith({scopes: CLOUD_PLATFORM_SCOPES});
      expect(fetchMock).toHaveBeenCalledWith(
        `${ROOT}/${API_NAME}`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer adc_token',
          }),
        }),
      );
    });

    it('should reject malformed service account JSON without echoing it', async () => {
      const secret = '{not json';
      const client = new APIHubClient({serviceAccountJson: secret});

      const error = await rejectionOf(client.getApi(API_NAME));

      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('Invalid service account JSON: ');
      expect(String(error)).not.toContain(secret);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should reject when application default credentials are unavailable', async () => {
      getClientRejects = true;

      await expect(new APIHubClient().getApi(API_NAME)).rejects.toThrow(
        'Please provide a service account or an access token to API Hub client.',
      );
    });

    it('should preserve the underlying credential failure as the cause', async () => {
      getClientRejects = true;

      const error = await rejectionOf(new APIHubClient().getApi(API_NAME));

      expect(error).toHaveProperty(
        'cause.message',
        'Could not load the default credentials',
      );
    });

    it('should reject when the credential yields no token', async () => {
      adcToken = null;

      await expect(new APIHubClient().getApi(API_NAME)).rejects.toThrow(
        'Please provide a service account or an access token to API Hub client.',
      );
    });

    it('should reuse one auth client across requests', async () => {
      const client = new APIHubClient();

      await client.getApi(API_NAME);
      await client.getApi(API_NAME);

      expect(GoogleAuth).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
