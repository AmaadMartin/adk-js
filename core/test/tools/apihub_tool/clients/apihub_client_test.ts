/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {APIHubClient} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {extractResourceName} from '../../../../src/tools/apihub_tool/clients/apihub_client.js';

const {googleAuthMock, getAccessTokenMock} = vi.hoisted(() => {
  const getAccessTokenMock = vi.fn<() => Promise<string | null>>();
  const googleAuthMock = vi.fn((options: unknown) => ({
    options,
    getAccessToken: getAccessTokenMock,
  }));
  return {googleAuthMock, getAccessTokenMock};
});

vi.mock('google-auth-library', () => ({GoogleAuth: googleAuthMock}));

const ROOT = 'https://apihub.googleapis.com/v1';
const API_NAME = 'projects/test-project/locations/us-central1/apis/api1';
const VERSION_NAME = `${API_NAME}/versions/v1`;
const SPEC_NAME = `${VERSION_NAME}/specs/spec1`;
const EXPECTED_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'Authorization': 'Bearer mocked_token',
};
const SPEC_PAYLOAD = {
  contents: Buffer.from('spec content', 'utf-8').toString('base64'),
};

const fetchMock = vi.fn<typeof fetch>();

/** Queues one JSON response body per expected request, in order. */
function respondWith(...payloads: unknown[]): void {
  for (const payload of payloads) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(payload), {status: 200}),
    );
  }
}

/** Returns the init object of the n-th `fetch` call. */
function fetchInit(callIndex: number) {
  const init = fetchMock.mock.calls[callIndex][1];
  if (!init) {
    expect.fail(`fetch call ${callIndex} carried no init object`);
  }
  return init;
}

describe('APIHubClient', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    googleAuthMock.mockClear();
    getAccessTokenMock.mockReset();
    getAccessTokenMock.mockResolvedValue('adc_token');
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function client(): APIHubClient {
    return new APIHubClient({accessToken: 'mocked_token'});
  }

  describe('getApi', () => {
    it('should request the API resource', async () => {
      const api = {name: API_NAME, versions: [VERSION_NAME]};
      respondWith(api);

      expect(await client().getApi(API_NAME)).toEqual(api);
      expect(fetchMock.mock.calls[0][0]).toBe(`${ROOT}/${API_NAME}`);
      expect(fetchInit(0).headers).toEqual(EXPECTED_HEADERS);
    });

    it('should bound the request with a timeout signal', async () => {
      respondWith({name: API_NAME});

      await client().getApi(API_NAME);

      expect(fetchInit(0).signal).toBeInstanceOf(AbortSignal);
    });

    it('should reject on a non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('boom', {status: 500}));

      await expect(client().getApi(API_NAME)).rejects.toThrow(
        'API Hub request failed with status 500: boom',
      );
    });
  });

  describe('getApiVersion', () => {
    it('should request the API version resource', async () => {
      const version = {name: VERSION_NAME, specs: [SPEC_NAME]};
      respondWith(version);

      expect(await client().getApiVersion(VERSION_NAME)).toEqual(version);
      expect(fetchMock.mock.calls[0][0]).toBe(`${ROOT}/${VERSION_NAME}`);
      expect(fetchInit(0).headers).toEqual(EXPECTED_HEADERS);
    });

    it('should reject on a non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('boom', {status: 404}));

      await expect(client().getApiVersion(VERSION_NAME)).rejects.toThrow(
        'API Hub request failed with status 404: boom',
      );
    });
  });

  describe('getSpecContent', () => {
    it('should fetch only the contents when the path names a spec', async () => {
      respondWith(SPEC_PAYLOAD);

      expect(await client().getSpecContent(SPEC_NAME)).toBe('spec content');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(`${ROOT}/${SPEC_NAME}:contents`);
    });

    it('should walk to the first spec when the path names a version', async () => {
      respondWith({name: VERSION_NAME, specs: [SPEC_NAME]}, SPEC_PAYLOAD);

      expect(await client().getSpecContent(VERSION_NAME)).toBe('spec content');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(`${ROOT}/${VERSION_NAME}`);
      expect(fetchMock.mock.calls[1][0]).toBe(`${ROOT}/${SPEC_NAME}:contents`);
    });

    it('should walk to the first version and spec when the path names an api', async () => {
      respondWith(
        {name: API_NAME, versions: [VERSION_NAME]},
        {name: VERSION_NAME, specs: [SPEC_NAME]},
        SPEC_PAYLOAD,
      );

      expect(await client().getSpecContent(API_NAME)).toBe('spec content');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[0][0]).toBe(`${ROOT}/${API_NAME}`);
      expect(fetchMock.mock.calls[1][0]).toBe(`${ROOT}/${VERSION_NAME}`);
      expect(fetchMock.mock.calls[2][0]).toBe(`${ROOT}/${SPEC_NAME}:contents`);
    });

    it('should return an empty string when the spec has empty contents', async () => {
      respondWith({contents: ''});

      expect(await client().getSpecContent(SPEC_NAME)).toBe('');
    });

    it('should return an empty string when the spec has no contents field', async () => {
      respondWith({});

      expect(await client().getSpecContent(SPEC_NAME)).toBe('');
    });

    it('should reject when the API has no version', async () => {
      respondWith({name: API_NAME, versions: []});

      await expect(client().getSpecContent(API_NAME)).rejects.toThrow(
        `No versions found in API Hub resource: ${API_NAME}`,
      );
    });

    it('should reject when the API has no versions field', async () => {
      respondWith({name: API_NAME});

      await expect(client().getSpecContent(API_NAME)).rejects.toThrow(
        `No versions found in API Hub resource: ${API_NAME}`,
      );
    });

    it('should reject when the version has no spec', async () => {
      respondWith({name: VERSION_NAME, specs: []});

      await expect(client().getSpecContent(VERSION_NAME)).rejects.toThrow(
        `No specs found in API Hub version: ${VERSION_NAME}`,
      );
    });

    it('should reject when the version has no specs field', async () => {
      respondWith({name: VERSION_NAME});

      await expect(client().getSpecContent(VERSION_NAME)).rejects.toThrow(
        `No specs found in API Hub version: ${VERSION_NAME}`,
      );
    });

    it('should reject on a non-2xx response', async () => {
      fetchMock.mockResolvedValueOnce(new Response('boom', {status: 400}));

      await expect(client().getSpecContent(SPEC_NAME)).rejects.toThrow(
        'API Hub request failed with status 400: boom',
      );
    });

    it('should reject an unparsable path without any request', async () => {
      await expect(client().getSpecContent('invalid-path')).rejects.toThrow(
        "Input path is 'invalid-path'",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('access token', () => {
    it('should not build a GoogleAuth when an access token is set', async () => {
      respondWith(SPEC_PAYLOAD);

      await client().getSpecContent(SPEC_NAME);

      expect(googleAuthMock).not.toHaveBeenCalled();
      expect(fetchInit(0).headers).toEqual(EXPECTED_HEADERS);
    });

    it('should build one GoogleAuth for application default credentials', async () => {
      respondWith(SPEC_PAYLOAD, SPEC_PAYLOAD);
      const apihubClient = new APIHubClient();

      await apihubClient.getSpecContent(SPEC_NAME);
      await apihubClient.getSpecContent(SPEC_NAME);

      expect(googleAuthMock).toHaveBeenCalledTimes(1);
      expect(googleAuthMock).toHaveBeenCalledWith({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      expect(fetchInit(0).headers).toEqual({
        ...EXPECTED_HEADERS,
        Authorization: 'Bearer adc_token',
      });
    });

    it('should build a GoogleAuth from the service account key', async () => {
      respondWith(SPEC_PAYLOAD);
      const key = {
        type: 'service_account',
        project_id: 'test',
        token_uri: 'https://example.com/token',
        client_email: 'test@example.com',
        private_key: 'key-material',
      };

      await new APIHubClient({
        serviceAccountJson: JSON.stringify(key),
      }).getSpecContent(SPEC_NAME);

      expect(googleAuthMock).toHaveBeenCalledWith({
        credentials: key,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    });

    it('should not quote the key when the service account JSON is malformed', async () => {
      // JSON.parse quotes this input verbatim in its message, so a message
      // built from the parser error would carry the key material.
      const failure = new APIHubClient({
        serviceAccountJson: 'PRIVATE_KEY_MATERIAL',
      }).getSpecContent(SPEC_NAME);

      await expect(failure).rejects.toThrowError(
        new Error('Invalid service account JSON: the key is not valid JSON.'),
      );
      await expect(failure).rejects.not.toThrow(/PRIVATE_KEY_MATERIAL/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should reject when the credentials cannot be resolved', async () => {
      getAccessTokenMock.mockRejectedValue(new Error('no ADC'));

      await expect(
        new APIHubClient().getSpecContent(SPEC_NAME),
      ).rejects.toThrow(
        'Please provide a service account or an access token to API Hub client.',
      );
    });

    it('should reject when the resolved token is empty', async () => {
      getAccessTokenMock.mockResolvedValue(null);

      await expect(
        new APIHubClient().getSpecContent(SPEC_NAME),
      ).rejects.toThrow(
        'Please provide a service account or an access token to API Hub client.',
      );
    });
  });
});

describe('extractResourceName', () => {
  it.each([
    [
      'an api path',
      API_NAME,
      {
        apiResourceName: API_NAME,
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      },
    ],
    [
      'an api version path',
      VERSION_NAME,
      {
        apiResourceName: API_NAME,
        apiVersionResourceName: VERSION_NAME,
        apiSpecResourceName: undefined,
      },
    ],
    [
      'an api spec path',
      SPEC_NAME,
      {
        apiResourceName: API_NAME,
        apiVersionResourceName: VERSION_NAME,
        apiSpecResourceName: SPEC_NAME,
      },
    ],
    [
      'a console url naming a version',
      `https://console.cloud.google.com/apigee/api-hub/${VERSION_NAME}?project=test-project`,
      {
        apiResourceName: API_NAME,
        apiVersionResourceName: VERSION_NAME,
        apiSpecResourceName: undefined,
      },
    ],
    [
      'a console url naming a spec',
      `https://console.cloud.google.com/apigee/api-hub/${SPEC_NAME}?project=test-project`,
      {
        apiResourceName: API_NAME,
        apiVersionResourceName: VERSION_NAME,
        apiSpecResourceName: SPEC_NAME,
      },
    ],
    [
      'a leading slash',
      `/${VERSION_NAME}`,
      {
        apiResourceName: API_NAME,
        apiVersionResourceName: VERSION_NAME,
        apiSpecResourceName: undefined,
      },
    ],
    [
      'a trailing slash',
      `${API_NAME}/`,
      {
        apiResourceName: API_NAME,
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      },
    ],
    [
      'an uppercase location',
      'projects/test-project/locations/LOCATION/apis/api1/',
      {
        apiResourceName: 'projects/test-project/locations/LOCATION/apis/api1',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      },
    ],
    [
      'short ids',
      'projects/p1/locations/l1/apis/a1/versions/v1/specs/s1',
      {
        apiResourceName: 'projects/p1/locations/l1/apis/a1',
        apiVersionResourceName: 'projects/p1/locations/l1/apis/a1/versions/v1',
        apiSpecResourceName:
          'projects/p1/locations/l1/apis/a1/versions/v1/specs/s1',
      },
    ],
    [
      'an api named api-hub',
      'projects/p/locations/l/apis/api-hub/versions/v1',
      {
        apiResourceName: 'projects/p/locations/l/apis/api-hub',
        apiVersionResourceName:
          'projects/p/locations/l/apis/api-hub/versions/v1',
        apiSpecResourceName: undefined,
      },
    ],
    [
      'a project taken from the query only',
      'https://console.cloud.google.com/apigee/api-hub/locations/us-central1/apis/api1?project=test-project',
      {
        apiResourceName: API_NAME,
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      },
    ],
    [
      'a spec without a version',
      'projects/p1/locations/l1/apis/a1/specs/s1',
      {
        apiResourceName: 'projects/p1/locations/l1/apis/a1',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      },
    ],
  ])('should resolve %s', (_label, input, expected) => {
    expect(extractResourceName(input)).toEqual(expected);
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
    ['projects', 'Project ID not found in URL or path in APIHubClient.'],
    [
      'projects/p/locations',
      'Location not found in URL or path in APIHubClient.',
    ],
    [
      'projects/p/locations/l/apis',
      'API id not found in URL or path in APIHubClient.',
    ],
  ])('should reject %s', (input, message) => {
    expect(() => extractResourceName(input)).toThrow(message);
    expect(() => extractResourceName(input)).toThrow(
      `Input path is '${input}'`,
    );
  });

  it('should treat an unparsable url as a plain path', () => {
    expect(() => extractResourceName('http://[')).toThrow(
      "Project ID not found in URL or path in APIHubClient. Input path is 'http://['",
    );
  });
});
