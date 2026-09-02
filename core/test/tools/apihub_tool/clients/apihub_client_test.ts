/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {APIHubClient} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';
import {Buffer} from 'node:buffer';
import {EventEmitter} from 'node:events';
import * as https from 'node:https';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ApiHubResourceNames,
  extractResourceName,
} from '../../../../src/tools/apihub_tool/clients/apihub_client.js';
import {MtlsClientCerts} from '../../../../src/utils/mtls_utils.js';

const {googleAuthMock, getAccessTokenMock} = vi.hoisted(() => {
  const getAccessTokenMock = vi.fn<() => Promise<string | null>>();
  const googleAuthMock = vi.fn((options: unknown) => ({
    options,
    getAccessToken: getAccessTokenMock,
  }));
  return {googleAuthMock, getAccessTokenMock};
});

vi.mock('google-auth-library', () => ({GoogleAuth: googleAuthMock}));

const {httpsRequestMock, clientCertsToPresentMock} = vi.hoisted(() => ({
  httpsRequestMock: vi.fn<FakeHttpsRequest>(),
  clientCertsToPresentMock: vi.fn<() => Promise<MtlsClientCerts | undefined>>(),
}));

// `https.Agent` stays real, so the assertions read the certificate material the
// client actually handed to Node.
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof https>();
  return {
    ...actual,
    default: {...actual, request: httpsRequestMock},
    request: httpsRequestMock,
  };
});

// Only the certificate lookup is faked. The host rewrite and the mutual-TLS
// transport stay real, so the assertions below pin what the client sends.
vi.mock('../../../../src/utils/mtls_utils.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../../../src/utils/mtls_utils.js')
  >()),
  clientCertsToPresent: clientCertsToPresentMock,
}));

const ROOT = 'https://apihub.googleapis.com/v1';
const PROJECT = 'test-project';
const LOCATION = 'us-central1';
const API_NAME = `projects/${PROJECT}/locations/${LOCATION}/apis/api1`;
const VERSION_NAME = `${API_NAME}/versions/v1`;
const SPEC_NAME = `${VERSION_NAME}/specs/spec1`;
const EXPECTED_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'Authorization': 'Bearer mocked_token',
};
const SPEC_PAYLOAD = {
  contents: Buffer.from('spec content', 'utf-8').toString('base64'),
};

const MOCK_API_LIST = {
  apis: [
    {name: API_NAME},
    {name: `projects/${PROJECT}/locations/${LOCATION}/apis/api2`},
  ],
};
const MOCK_API_DETAIL = {name: API_NAME, versions: [VERSION_NAME]};
const MOCK_API_VERSION = {name: VERSION_NAME, specs: [SPEC_NAME]};

const AUTHORIZED_GET = {
  method: 'GET',
  headers: EXPECTED_HEADERS,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

/** Resolves every call to a fresh response, since a body is readable once. */
function alwaysRespondWith(body: unknown): void {
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(body)));
}

/** Returns the rejection of a promise, or undefined when it resolves. */
function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
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

describe('apihub_client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    getAccessTokenMock.mockReset();
    getAccessTokenMock.mockResolvedValue('adc_token');
    vi.mocked(GoogleAuth).mockClear();
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
      [
        `projects/${PROJECT}/locations/${LOCATION}/apis/api1/specs/spec1`,
        {apiResourceName: API_NAME},
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
      alwaysRespondWith(MOCK_API_LIST);

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
      alwaysRespondWith({apis: []});
      expect(await client.listApis(PROJECT, LOCATION)).toEqual([]);

      alwaysRespondWith({});
      expect(await client.listApis(PROJECT, LOCATION)).toEqual([]);
    });

    it('should get an API by resource name', async () => {
      alwaysRespondWith(MOCK_API_DETAIL);

      expect(await client.getApi(API_NAME)).toEqual(MOCK_API_DETAIL);
      expect(fetchMock).toHaveBeenCalledWith(
        `${ROOT}/${API_NAME}`,
        expect.objectContaining(AUTHORIZED_GET),
      );
    });

    it('should get an API version by resource name', async () => {
      alwaysRespondWith(MOCK_API_VERSION);

      expect(await client.getApiVersion(VERSION_NAME)).toEqual(
        MOCK_API_VERSION,
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `${ROOT}/${VERSION_NAME}`,
        expect.objectContaining(AUTHORIZED_GET),
      );
    });

    it('should bound every request with an abort signal', async () => {
      alwaysRespondWith(MOCK_API_DETAIL);

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
      alwaysRespondWith(SPEC_PAYLOAD);

      expect(await client.getSpecContent(SPEC_NAME)).toBe('spec content');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `${ROOT}/${SPEC_NAME}:contents`,
        expect.objectContaining(AUTHORIZED_GET),
      );
    });

    it('should decode non-ASCII spec text as UTF-8', async () => {
      const specText = 'title: 天気 API — café ☕';
      alwaysRespondWith({
        contents: Buffer.from(specText, 'utf-8').toString('base64'),
      });

      expect(await client.getSpecContent(SPEC_NAME)).toBe(specText);
    });

    it('should resolve the first spec for a version-level name', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            ...MOCK_API_VERSION,
            specs: [SPEC_NAME, `${VERSION_NAME}/specs/spec2`],
          }),
        )
        .mockResolvedValueOnce(jsonResponse(SPEC_PAYLOAD));

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
        .mockResolvedValueOnce(jsonResponse(SPEC_PAYLOAD));

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
        alwaysRespondWith(body);

        expect(await client.getSpecContent(SPEC_NAME)).toBe('');
      },
    );

    it.each<[string, object]>([
      ['empty', {name: API_NAME, versions: []}],
      ['absent', {name: API_NAME}],
    ])('should reject when the API versions are %s', async (_name, body) => {
      alwaysRespondWith(body);

      await expect(client.getSpecContent(API_NAME)).rejects.toThrow(
        `No versions found in API Hub resource: ${API_NAME}`,
      );
    });

    it.each<[string, object]>([
      ['empty', {name: VERSION_NAME, specs: []}],
      ['absent', {name: VERSION_NAME}],
    ])('should reject when the version specs are %s', async (_name, body) => {
      alwaysRespondWith(body);

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
      alwaysRespondWith(MOCK_API_DETAIL);
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
      getAccessTokenMock.mockResolvedValue('service_account_token');
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
      getAccessTokenMock.mockRejectedValue(
        new Error('Could not load the default credentials'),
      );

      await expect(new APIHubClient().getApi(API_NAME)).rejects.toThrow(
        'Please provide a service account or an access token to API Hub client.',
      );
    });

    it('should preserve the underlying credential failure as the cause', async () => {
      getAccessTokenMock.mockRejectedValue(
        new Error('Could not load the default credentials'),
      );

      const error = await rejectionOf(new APIHubClient().getApi(API_NAME));

      expect(error).toHaveProperty(
        'cause.message',
        'Could not load the default credentials',
      );
    });

    it('should reject when the credential yields no token', async () => {
      getAccessTokenMock.mockResolvedValue(null);

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

/** The part of an outgoing request the client drives. */
interface FakeRequest extends EventEmitter {
  end(): void;
  destroy(error?: Error): void;
}

/** The part of an incoming response the client reads. */
interface FakeResponse extends EventEmitter {
  /** Node leaves this unset when the response carries no status line. */
  statusCode?: number;
  setEncoding(encoding: string): void;
}

/** The request options the client passes to `https.request`. */
interface FakeRequestOptions {
  headers: Record<string, string>;
  timeout: number;
  agent: https.Agent;
}

type FakeHttpsRequest = (
  url: string,
  options: FakeRequestOptions,
  onResponse: (response: FakeResponse) => void,
) => FakeRequest;

/** Builds a request that reports a `destroy()` as Node does, with an error. */
function fakeRequest(end: () => void): FakeRequest {
  const request: FakeRequest = Object.assign(new EventEmitter(), {
    end,
    destroy: (error?: Error) => {
      request.emit('error', error);
    },
  });
  return request;
}

/** Makes the mocked `https.request` answer with a JSON body. */
function httpsRespondsWith(payload: unknown, status = 200): void {
  httpsRequestMock.mockImplementation((_url, _options, onResponse) =>
    fakeRequest(() => {
      const response: FakeResponse = Object.assign(new EventEmitter(), {
        statusCode: status,
        setEncoding: () => {},
      });
      onResponse(response);
      response.emit('data', JSON.stringify(payload));
      response.emit('end');
    }),
  );
}

const CERTS = {cert: 'cert-pem', key: 'key-pem', passphrase: 'secret'};
const APIS_URL = `${ROOT}/projects/${PROJECT}/locations/${LOCATION}/apis`;
const MTLS_APIS_URL = APIS_URL.replace(
  'apihub.googleapis.com',
  'apihub.mtls.googleapis.com',
);

describe('APIHubClient over mutual TLS', () => {
  let client: APIHubClient;

  beforeEach(() => {
    fetchMock.mockReset();
    httpsRequestMock.mockReset();
    clientCertsToPresentMock.mockResolvedValue(CERTS);
    getAccessTokenMock.mockReset();
    getAccessTokenMock.mockResolvedValue('adc_token');
    vi.stubGlobal('fetch', fetchMock);
    client = new APIHubClient({accessToken: 'mocked_token'});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('should route to the mTLS endpoint when a client certificate is available', async () => {
    httpsRespondsWith(MOCK_API_LIST);

    expect(await client.listApis(PROJECT, LOCATION)).toEqual(
      MOCK_API_LIST.apis,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(httpsRequestMock.mock.calls[0][0]).toBe(MTLS_APIS_URL);
  });

  it('should present the certificate and keep the headers and the deadline', async () => {
    httpsRespondsWith(MOCK_API_LIST);

    await client.listApis(PROJECT, LOCATION);

    const options = httpsRequestMock.mock.calls[0][1];
    expect(options.headers).toEqual(EXPECTED_HEADERS);
    expect(options.timeout).toBe(30_000);
    expect(options.agent.options).toMatchObject(CERTS);
  });

  it('should surface a non-2xx response from the mTLS endpoint', async () => {
    httpsRespondsWith({error: 'forbidden'}, 403);

    await expect(client.listApis(PROJECT, LOCATION)).rejects.toThrow(
      'API Hub request failed with status 403: {"error":"forbidden"}',
    );
  });

  it('should use the default endpoint when no client certificate is available', async () => {
    clientCertsToPresentMock.mockResolvedValue(undefined);
    alwaysRespondWith(MOCK_API_LIST);

    expect(await client.listApis(PROJECT, LOCATION)).toEqual(
      MOCK_API_LIST.apis,
    );
    expect(httpsRequestMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      APIS_URL,
      expect.objectContaining(AUTHORIZED_GET),
    );
  });

  it('should honour GOOGLE_API_USE_MTLS_ENDPOINT=never', async () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');
    httpsRespondsWith(MOCK_API_LIST);

    await client.listApis(PROJECT, LOCATION);

    expect(httpsRequestMock.mock.calls[0][0]).toBe(APIS_URL);
    expect(httpsRequestMock.mock.calls[0][1].agent.options).toMatchObject(
      CERTS,
    );
  });
});

describe('APIHubClient payload validation', () => {
  let client: APIHubClient;

  beforeEach(() => {
    fetchMock.mockReset();
    getAccessTokenMock.mockReset();
    getAccessTokenMock.mockResolvedValue('adc_token');
    vi.stubGlobal('fetch', fetchMock);
    client = new APIHubClient({accessToken: 'mocked_token'});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each<[string, unknown]>([
    ['an array', [1, 2]],
    ['a string', 'text'],
    ['null', null],
    ['a number', 42],
  ])('should reject a JSON response that is %s', async (_name, payload) => {
    alwaysRespondWith(payload);

    await expect(client.getApi(API_NAME)).rejects.toThrow(
      'API Hub returned a non-object JSON response.',
    );
  });

  it.each<[string, object]>([
    ['a list of numbers', {versions: [1]}],
    ['a plain string', {versions: 'v1'}],
    ['an object', {versions: {}}],
  ])('should reject a versions field that is %s', async (_name, apiPayload) => {
    alwaysRespondWith(apiPayload);

    await expect(client.getSpecContent(API_NAME)).rejects.toThrow(
      "API Hub field 'versions' must be a list of strings.",
    );
  });

  it('should reject a specs field that is not a list of strings', async () => {
    alwaysRespondWith({name: VERSION_NAME, specs: [{}]});

    await expect(client.getSpecContent(VERSION_NAME)).rejects.toThrow(
      "API Hub field 'specs' must be a list of strings.",
    );
  });

  it.each<[string, object]>([
    ['a list of strings', {apis: ['api1']}],
    ['an object', {apis: {}}],
  ])('should reject an apis field that is %s', async (_name, payload) => {
    alwaysRespondWith(payload);

    await expect(client.listApis(PROJECT, LOCATION)).rejects.toThrow(
      "API Hub field 'apis' must be a list of objects.",
    );
  });

  it('should reject a contents field that is not a string', async () => {
    alwaysRespondWith({contents: 123});

    await expect(client.getSpecContent(SPEC_NAME)).rejects.toThrow(
      "API Hub field 'contents' must be a string.",
    );
  });

  it.each(['"a string"', '[]'])(
    'should reject a service account key that is %s',
    async (serviceAccountJson) => {
      await expect(
        new APIHubClient({serviceAccountJson}).getApi(API_NAME),
      ).rejects.toThrow('Service account JSON must contain an object.');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('APIHubClient with an unresolvable path', () => {
  let client: APIHubClient;

  beforeEach(() => {
    fetchMock.mockReset();
    getAccessTokenMock.mockReset();
    getAccessTokenMock.mockResolvedValue('adc_token');
    vi.stubGlobal('fetch', fetchMock);
    client = new APIHubClient({accessToken: 'mocked_token'});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should reject when the API resolves to an empty version name', async () => {
    alwaysRespondWith({name: API_NAME, versions: ['']});

    await expect(client.getSpecContent(API_NAME)).rejects.toThrow(
      `No API Hub resource found in path: ${API_NAME}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should reject when the version resolves to an empty spec name', async () => {
    alwaysRespondWith({name: VERSION_NAME, specs: ['']});

    await expect(client.getSpecContent(VERSION_NAME)).rejects.toThrow(
      `No API Hub resource found in path: ${VERSION_NAME}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
