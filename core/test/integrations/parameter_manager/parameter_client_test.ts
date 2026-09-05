/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/parameter_manager/test_parameter_client.py`,
 * branch `main`, commit `25f5214c`. The first describe block keeps the Python
 * test names verbatim; the second pins behaviour that has no Python
 * counterpart.
 */

import {
  InputValidationError,
  ParameterManagerClient,
  ParameterManagerClientOptions,
  version,
} from '@google/adk';
import type {Credentials, GoogleAuthOptions} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/** The request options {@link ParameterManagerClient} sends to the auth client. */
interface RequestOptions {
  url: string;
  headers: Record<string, string>;
}

/** The response shape the auth client resolves to for a `:render` call. */
interface RenderResponse {
  data: {renderedPayload?: string};
}

const mocks = vi.hoisted(() => {
  const request = vi.fn<(options: RequestOptions) => Promise<RenderResponse>>();
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
    FakeGoogleAuth,
    FakeOAuth2Client,
    getClient,
    googleAuthConstructor,
    oauthConstructor,
    oauthSetCredentials,
    request,
  };
});

vi.mock('google-auth-library', () => ({
  GoogleAuth: mocks.FakeGoogleAuth,
  OAuth2Client: mocks.FakeOAuth2Client,
}));

const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const RESOURCE_NAME =
  'projects/test-project/locations/global/parameters/test-param/versions/latest';
const GLOBAL_URL = `https://parametermanager.googleapis.com/v1/${RESOURCE_NAME}:render`;
const REGIONAL_HOST = 'parametermanager.us-central1.rep.googleapis.com';
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'key-id',
  private_key: 'private-key',
  client_email: 'test@example.com',
};

/** Builds the value `AuthClient.request` resolves to for a rendered payload. */
function renderResponse(payload: string): RenderResponse {
  return {data: {renderedPayload: Buffer.from(payload).toString('base64')}};
}

/** Returns the options passed to the single recorded request. */
function recordedRequest(): RequestOptions {
  const call = mocks.request.mock.calls[0];
  expect(call).toBeDefined();
  return call[0];
}

/** Returns the host of the single recorded request. */
function recordedHost(): string {
  return new URL(recordedRequest().url).host;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getClient.mockResolvedValue({request: mocks.request});
  mocks.request.mockResolvedValue(renderResponse('parameter-value'));
});

describe('ParameterManagerClient ported reference tests', () => {
  it('test_init_with_default_credentials', async () => {
    const client = new ParameterManagerClient();

    expect(mocks.googleAuthConstructor).toHaveBeenCalledExactlyOnceWith({
      scopes: SCOPES,
    });
    expect(mocks.oauthConstructor).not.toHaveBeenCalled();

    await client.getParameter(RESOURCE_NAME);

    expect(recordedHost()).toBe('parametermanager.googleapis.com');
  });

  it('test_init_with_service_account_json', () => {
    new ParameterManagerClient({
      serviceAccountJson: JSON.stringify(SERVICE_ACCOUNT),
    });

    expect(mocks.googleAuthConstructor).toHaveBeenCalledExactlyOnceWith({
      credentials: SERVICE_ACCOUNT,
      scopes: SCOPES,
    });
    expect(mocks.oauthConstructor).not.toHaveBeenCalled();
  });

  it('test_init_with_auth_token', () => {
    new ParameterManagerClient({authToken: 'test-token'});

    expect(mocks.oauthConstructor).toHaveBeenCalledOnce();
    expect(mocks.oauthSetCredentials).toHaveBeenCalledExactlyOnceWith({
      access_token: 'test-token',
    });
    expect(mocks.googleAuthConstructor).toHaveBeenCalledExactlyOnceWith({
      authClient: expect.any(mocks.FakeOAuth2Client),
      scopes: SCOPES,
    });
  });

  it('test_init_with_location', async () => {
    const client = new ParameterManagerClient({location: 'us-central1'});
    await client.getParameter(RESOURCE_NAME);

    expect(recordedHost()).toBe(REGIONAL_HOST);
  });

  it('test_init_with_default_credentials_error', async () => {
    mocks.getClient.mockRejectedValue(new Error('Auth error'));

    const client = new ParameterManagerClient();

    await expect(client.getParameter(RESOURCE_NAME)).rejects.toThrow(
      "'serviceAccountJson' or 'authToken' are both missing, and error " +
        'occurred while trying to use default credentials: Auth error',
    );
    await expect(client.getParameter(RESOURCE_NAME)).rejects.toThrow(
      InputValidationError,
    );
  });

  it('test_init_with_invalid_service_account_json', () => {
    expect(
      () => new ParameterManagerClient({serviceAccountJson: 'invalid-json'}),
    ).toThrow(/Invalid service account JSON/);
    expect(mocks.googleAuthConstructor).not.toHaveBeenCalled();
  });

  it('test_init_with_both_service_account_json_and_auth_token', () => {
    expect(
      () =>
        new ParameterManagerClient({
          serviceAccountJson: JSON.stringify(SERVICE_ACCOUNT),
          authToken: 'test-token',
        }),
    ).toThrow(
      "Must provide either 'serviceAccountJson' or 'authToken', not both.",
    );
    expect(mocks.googleAuthConstructor).not.toHaveBeenCalled();
  });

  it('test_get_parameter', async () => {
    const client = new ParameterManagerClient();

    await expect(client.getParameter(RESOURCE_NAME)).resolves.toBe(
      'parameter-value',
    );
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(recordedRequest().url).toBe(GLOBAL_URL);
  });

  it('test_get_parameter_error', async () => {
    const apiError = new Error('API error');
    mocks.request.mockRejectedValue(apiError);

    const client = new ParameterManagerClient();

    await expect(client.getParameter(RESOURCE_NAME)).rejects.toBe(apiError);
  });
});

describe('ParameterManagerClient input validation', () => {
  it('rejects service account JSON that is not an object', () => {
    expect(
      () => new ParameterManagerClient({serviceAccountJson: '123'}),
    ).toThrow('Invalid service account JSON: expected a JSON object.');
    expect(mocks.googleAuthConstructor).not.toHaveBeenCalled();
  });

  it('rejects a location that is not a location ID', () => {
    expect(() => new ParameterManagerClient({location: 'evil.com/'})).toThrow(
      'Invalid location: evil.com/',
    );
    expect(mocks.googleAuthConstructor).not.toHaveBeenCalled();
  });

  it('rejects a location holding regular expression metacharacters', () => {
    expect(() => new ParameterManagerClient({location: '$&'})).toThrow(
      'Invalid location: $&',
    );
  });

  it.each<[string, ParameterManagerClientOptions]>([
    ['unparsable service account JSON', {serviceAccountJson: 'invalid-json'}],
    ['a service account JSON scalar', {serviceAccountJson: '123'}],
    ['a location that is not a location ID', {location: 'evil.com/'}],
    [
      'both credential sources',
      {serviceAccountJson: '{}', authToken: 'test-token'},
    ],
  ])('rejects %s with an InputValidationError', (_, options) => {
    expect(() => new ParameterManagerClient(options)).toThrow(
      InputValidationError,
    );
  });

  it.each([
    ['a name that is not a resource name', 'not-a-resource-name'],
    ['a name missing the version', 'projects/p/locations/global/parameters/n'],
    [
      'a name carrying a query string',
      'projects/p/locations/global/parameters/n/versions/1?alt=media',
    ],
    [
      'a name carrying a fragment',
      'projects/p/locations/global/parameters/n/versions/1#f',
    ],
    ['a name with no locations segment', 'projects/p/parameters/n/versions/1'],
    ['an empty name', ''],
  ])('rejects %s without issuing a request', async (_, resourceName) => {
    const client = new ParameterManagerClient();

    await expect(client.getParameter(resourceName)).rejects.toThrow(
      InputValidationError,
    );
    expect(mocks.getClient).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('names the rejected resource name in the error', async () => {
    const client = new ParameterManagerClient();

    await expect(client.getParameter('bad-name')).rejects.toThrow(
      'Invalid parameter resource name: bad-name. Expected ' +
        '"projects/*/locations/*/parameters/*/versions/*".',
    );
  });
});

describe('ParameterManagerClient getParameter', () => {
  it('decodes a multi-byte payload as UTF-8', async () => {
    mocks.request.mockResolvedValue(renderResponse('pässwörd-✓'));

    const client = new ParameterManagerClient();

    await expect(client.getParameter(RESOURCE_NAME)).resolves.toBe(
      'pässwörd-✓',
    );
  });

  it('returns an empty string for an empty payload', async () => {
    mocks.request.mockResolvedValue(renderResponse(''));

    const client = new ParameterManagerClient();

    await expect(client.getParameter(RESOURCE_NAME)).resolves.toBe('');
  });

  it('returns an empty string when the response omits the payload', async () => {
    mocks.request.mockResolvedValue({data: {}});

    const client = new ParameterManagerClient();

    await expect(client.getParameter(RESOURCE_NAME)).resolves.toBe('');
  });

  it('identifies itself with the ADK client labels', async () => {
    const client = new ParameterManagerClient();
    await client.getParameter(RESOURCE_NAME);

    const {headers} = recordedRequest();
    expect(headers['user-agent'].split(' ')[0]).toBe(`google-adk/${version}`);
    expect(headers['x-goog-api-client']).toBe(headers['user-agent']);
  });

  it('reuses one auth instance across calls', async () => {
    const client = new ParameterManagerClient();
    await client.getParameter(RESOURCE_NAME);
    await client.getParameter(RESOURCE_NAME);

    expect(mocks.googleAuthConstructor).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it('propagates a credential failure for an explicit auth token', async () => {
    const authError = new Error('token rejected');
    mocks.getClient.mockRejectedValue(authError);

    const client = new ParameterManagerClient({authToken: 'test-token'});

    await expect(client.getParameter(RESOURCE_NAME)).rejects.toBe(authError);
  });

  it('accepts a regional resource name', async () => {
    const regionalName =
      'projects/test-project/locations/us-central1/parameters/test-param/versions/3';

    const client = new ParameterManagerClient({location: 'us-central1'});

    await expect(client.getParameter(regionalName)).resolves.toBe(
      'parameter-value',
    );
    expect(recordedRequest().url).toBe(
      `https://${REGIONAL_HOST}/v1/${regionalName}:render`,
    );
  });
});
