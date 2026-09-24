/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python at ref `v0.1.0`:
 * `src/google/adk/tests/unittests/tools/apihub_tool/clients/test_apihub_client.py`.
 *
 * Each `it(...)` title is the Python test name verbatim, so a reviewer can
 * grep the original. The fixture constants keep their Python names for the
 * same reason.
 */

import {APIHubClient} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {extractResourceName} from '../../../../src/tools/apihub_tool/clients/apihub_client.js';

/**
 * Mutable state the `google-auth-library` mock reads. `GoogleAuth` stands in
 * for both `google.auth.default()` and
 * `service_account.Credentials.from_service_account_info()`: it is handed the
 * parsed keyfile as `credentials` when the caller configured one, and nothing
 * when it must fall back to Application Default Credentials.
 */
const authState = vi.hoisted(() => ({
  /** Tokens Application Default Credentials yield, in order. */
  adcTokens: [] as Array<string | undefined>,
  /** Tokens the service-account client yields, in order. */
  jwtTokens: [] as Array<string | undefined>,
  /** When set, `GoogleAuth.getClient` rejects with it. */
  adcFailure: undefined as Error | undefined,
  googleAuthCount: 0,
  jwtCount: 0,
  /** The options every `GoogleAuth` built from a keyfile was given. */
  jwtOptions: [] as Array<{credentials?: unknown; scopes?: string[]}>,
}));

vi.mock('google-auth-library', () => {
  const nextToken = (tokens: Array<string | undefined>) =>
    tokens.length > 1 ? tokens.shift() : tokens[0];
  return {
    GoogleAuth: class {
      private readonly fromKeyfile: boolean;

      constructor(options: {credentials?: unknown; scopes?: string[]}) {
        this.fromKeyfile = Boolean(options.credentials);
        if (this.fromKeyfile) {
          authState.jwtCount++;
          authState.jwtOptions.push(options);
        } else {
          authState.googleAuthCount++;
        }
      }

      async getClient() {
        if (this.fromKeyfile) {
          return {
            getAccessToken: async () => ({
              token: nextToken(authState.jwtTokens),
            }),
          };
        }
        if (authState.adcFailure) {
          throw authState.adcFailure;
        }
        return {
          getAccessToken: async () => ({token: nextToken(authState.adcTokens)}),
        };
      }
    },
  };
});

const MOCK_API_LIST = {
  apis: [
    {name: 'projects/test-project/locations/us-central1/apis/api1'},
    {name: 'projects/test-project/locations/us-central1/apis/api2'},
  ],
};
const MOCK_API_DETAIL = {
  name: 'projects/test-project/locations/us-central1/apis/api1',
  versions: [
    'projects/test-project/locations/us-central1/apis/api1/versions/v1',
  ],
};
const MOCK_API_VERSION = {
  name: 'projects/test-project/locations/us-central1/apis/api1/versions/v1',
  specs: [
    'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
  ],
};
const MOCK_SPEC_CONTENT = {
  contents: Buffer.from('spec content').toString('base64'),
};

/** The two headers every API Hub request carries, with the fixture token. */
const MOCKED_TOKEN_HEADERS = {
  headers: {
    accept: 'application/json, text/plain, */*',
    Authorization: 'Bearer mocked_token',
  },
};

const SERVICE_ACCOUNT_CONFIG = JSON.stringify({
  type: 'service_account',
  project_id: 'test',
  token_uri: 'test.com',
  client_email: 'test@example.com',
  private_key: '1234',
});

/** Queues one successful JSON response per API Hub call, in order. */
function queueJson(...payloads: unknown[]): void {
  for (const payload of payloads) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(payload), {status: 200}),
    );
  }
}

/** Queues one failing response, standing in for `raise_for_status`. */
function queueError(): void {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response('server error', {status: 500}),
  );
}

describe('APIHubClient (adk-python v0.1.0 parity)', () => {
  let client: APIHubClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    authState.adcTokens = ['default_token'];
    authState.jwtTokens = ['config_token'];
    authState.adcFailure = undefined;
    authState.googleAuthCount = 0;
    authState.jwtCount = 0;
    authState.jwtOptions = [];
    client = new APIHubClient({accessToken: 'mocked_token'});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('test_list_apis', async () => {
    queueJson(MOCK_API_LIST);

    const apis = await client.listApis('test-project', 'us-central1');

    expect(apis).toEqual(MOCK_API_LIST.apis);
    expect(globalThis.fetch).toHaveBeenCalledExactlyOnceWith(
      'https://apihub.googleapis.com/v1/projects/test-project/locations/us-central1/apis',
      MOCKED_TOKEN_HEADERS,
    );
  });

  it('test_list_apis_empty', async () => {
    queueJson({apis: []});

    await expect(
      client.listApis('test-project', 'us-central1'),
    ).resolves.toEqual([]);
  });

  it('test_list_apis_error', async () => {
    queueError();

    await expect(
      client.listApis('test-project', 'us-central1'),
    ).rejects.toThrow('API Hub request failed with status 500: server error');
  });

  it('test_get_api', async () => {
    queueJson(MOCK_API_DETAIL);

    const api = await client.getApi(
      'projects/test-project/locations/us-central1/apis/api1',
    );

    expect(api).toEqual(MOCK_API_DETAIL);
    expect(globalThis.fetch).toHaveBeenCalledExactlyOnceWith(
      'https://apihub.googleapis.com/v1/projects/test-project/locations/us-central1/apis/api1',
      MOCKED_TOKEN_HEADERS,
    );
  });

  it('test_get_api_error', async () => {
    queueError();

    await expect(
      client.getApi('projects/test-project/locations/us-central1/apis/api1'),
    ).rejects.toThrow('API Hub request failed with status 500');
  });

  it('test_get_api_version', async () => {
    queueJson(MOCK_API_VERSION);

    const apiVersion = await client.getApiVersion(
      'projects/test-project/locations/us-central1/apis/api1/versions/v1',
    );

    expect(apiVersion).toEqual(MOCK_API_VERSION);
    expect(globalThis.fetch).toHaveBeenCalledExactlyOnceWith(
      'https://apihub.googleapis.com/v1/projects/test-project/locations/us-central1/apis/api1/versions/v1',
      MOCKED_TOKEN_HEADERS,
    );
  });

  it('test_get_api_version_error', async () => {
    queueError();

    await expect(
      client.getApiVersion(
        'projects/test-project/locations/us-central1/apis/api1/versions/v1',
      ),
    ).rejects.toThrow('API Hub request failed with status 500');
  });

  it('test_get_spec_content', async () => {
    queueJson(MOCK_SPEC_CONTENT);

    const specContent = await client.getSpecContent(
      'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
    );

    expect(specContent).toBe('spec content');
    expect(globalThis.fetch).toHaveBeenCalledExactlyOnceWith(
      'https://apihub.googleapis.com/v1/projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1:contents',
      MOCKED_TOKEN_HEADERS,
    );
  });

  it('test_get_spec_content_empty', async () => {
    queueJson({contents: ''});

    await expect(
      client.getSpecContent(
        'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
      ),
    ).resolves.toBe('');
  });

  it('test_get_spec_content_error', async () => {
    queueError();

    await expect(
      client.getSpecContent(
        'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
      ),
    ).rejects.toThrow('API Hub request failed with status 500');
  });

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
        apiVersionResourceName: 'projects/p1/locations/l1/apis/a1/versions/v1',
        apiSpecResourceName:
          'projects/p1/locations/l1/apis/a1/versions/v1/specs/s1',
      },
    ],
  ])('test_extract_resource_name: %s', (urlOrPath, expected) => {
    expect(extractResourceName(urlOrPath)).toEqual(expected);
  });

  it('test_extract_resource_name', () => {
    expect(
      extractResourceName(
        'projects/p1/locations/l1/apis/a1/versions/v1/specs/s1',
      ),
    ).toEqual({
      apiResourceName: 'projects/p1/locations/l1/apis/a1',
      apiVersionResourceName: 'projects/p1/locations/l1/apis/a1/versions/v1',
      apiSpecResourceName:
        'projects/p1/locations/l1/apis/a1/versions/v1/specs/s1',
    });
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
  ])(
    'test_extract_resource_name_invalid: %s',
    (urlOrPath, expectedErrorMessage) => {
      expect(() => extractResourceName(urlOrPath)).toThrow(
        expectedErrorMessage,
      );
    },
  );

  it('test_extract_resource_name_invalid', () => {
    expect(() => extractResourceName('invalid-path')).toThrow(
      'Project ID not found in URL or path in APIHubClient.',
    );
  });

  // The four `_get_access_token` tests below diverge from adk-python twice, by
  // necessity. Python calls `client._get_access_token()` directly; the adk-js
  // method is `private`, so each test drives it through `listApis` and asserts
  // the `Authorization` header the request actually carries. Python also
  // asserts on `credentials.refresh`; `google-auth-library` refreshes inside
  // the auth client, so the cache assertion counts auth-client constructions
  // instead, which is the behaviour the Python assertion was pinning.

  it('test_get_access_token_use_default_credential', async () => {
    queueJson(MOCK_API_LIST);
    const defaultClient = new APIHubClient();

    await defaultClient.listApis('test-project', 'us-central1');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer default_token',
        }),
      }),
    );
    expect(authState.jwtCount).toBe(0);
  });

  it('test_get_access_token_use_configured_service_account', async () => {
    queueJson(MOCK_API_LIST);
    const saClient = new APIHubClient({
      serviceAccountJson: SERVICE_ACCOUNT_CONFIG,
    });

    await saClient.listApis('test-project', 'us-central1');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer config_token',
        }),
      }),
    );
    // adk-python asserts
    // `from_service_account_info(json.loads(config), scopes=[...])`, so the
    // whole keyfile reaches the credential, not two fields lifted out of it.
    expect(authState.jwtOptions).toEqual([
      {
        credentials: JSON.parse(SERVICE_ACCOUNT_CONFIG) as unknown,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
    ]);
    expect(authState.googleAuthCount).toBe(0);
  });

  it('test_get_access_token_not_expired_use_cached_token', async () => {
    queueJson(MOCK_API_LIST, MOCK_API_LIST);
    const defaultClient = new APIHubClient();

    await defaultClient.listApis('test-project', 'us-central1');
    await defaultClient.listApis('test-project', 'us-central1');

    expect(authState.googleAuthCount).toBe(1);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer default_token',
        }),
      }),
    );
  });

  it('test_get_access_token_expired_refresh', async () => {
    queueJson(MOCK_API_LIST, MOCK_API_LIST);
    // The cached auth client rotates the token when the old one expires. The
    // second request must carry the new token, not the first one.
    authState.adcTokens = ['first_token', 'second_token'];
    const defaultClient = new APIHubClient();

    await defaultClient.listApis('test-project', 'us-central1');
    await defaultClient.listApis('test-project', 'us-central1');

    expect(authState.googleAuthCount).toBe(1);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer second_token',
        }),
      }),
    );
  });

  it('test_get_access_token_no_credentials', async () => {
    authState.adcFailure = new Error('could not load the default credentials');

    await expect(
      new APIHubClient().listApis('test-project', 'us-central1'),
    ).rejects.toThrow(
      'Please provide a service account or an access token to API Hub client.',
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('test_get_spec_content_api_level', async () => {
    queueJson(MOCK_API_DETAIL, MOCK_API_VERSION, MOCK_SPEC_CONTENT);

    const content = await client.getSpecContent(
      'projects/test-project/locations/us-central1/apis/api1',
    );

    expect(content).toBe('spec content');
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('test_get_spec_content_version_level', async () => {
    queueJson(MOCK_API_VERSION, MOCK_SPEC_CONTENT);

    const content = await client.getSpecContent(
      'projects/test-project/locations/us-central1/apis/api1/versions/v1',
    );

    expect(content).toBe('spec content');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('test_get_spec_content_spec_level', async () => {
    queueJson(MOCK_SPEC_CONTENT);

    const content = await client.getSpecContent(
      'projects/test-project/locations/us-central1/apis/api1/versions/v1/specs/spec1',
    );

    expect(content).toBe('spec content');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('test_get_spec_content_no_versions', async () => {
    queueJson({
      name: 'projects/test-project/locations/us-central1/apis/api1',
      versions: [],
    });

    await expect(
      client.getSpecContent(
        'projects/test-project/locations/us-central1/apis/api1',
      ),
    ).rejects.toThrow(
      'No versions found in API Hub resource: projects/test-project/locations/us-central1/apis/api1',
    );
  });

  it('test_get_spec_content_no_specs', async () => {
    queueJson(MOCK_API_DETAIL, {
      name: 'projects/test-project/locations/us-central1/apis/api1/versions/v1',
      specs: [],
    });

    await expect(
      client.getSpecContent(
        'projects/test-project/locations/us-central1/apis/api1/versions/v1',
      ),
    ).rejects.toThrow(
      'No specs found in API Hub version: projects/test-project/locations/us-central1/apis/api1/versions/v1',
    );
  });

  it('test_get_spec_content_invalid_path', async () => {
    await expect(client.getSpecContent('invalid-path')).rejects.toThrow(
      "Project ID not found in URL or path in APIHubClient. Input path is 'invalid-path'.",
    );
  });
});
