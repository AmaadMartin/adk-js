/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * adk-js behaviour the ported adk-python `v0.1.0` suite does not reach:
 * the fixed endpoint, credential precedence, and the paths and payloads
 * TypeScript handles differently from Python.
 */

import {APIHubClient, BaseAPIHubClient} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {extractResourceName} from '../../../../src/tools/apihub_tool/clients/apihub_client.js';

/**
 * Mutable state the `google-auth-library` mock reads. The client resolves
 * both credential kinds through `GoogleAuth`, which is handed the keyfile
 * when there is one, so the mock reports which of the two it was given.
 */
const authState = vi.hoisted(() => ({
  adcToken: 'adc_token' as string | undefined,
  jwtToken: 'jwt_token' as string | undefined,
  /** When set, `GoogleAuth.getClient` rejects with it. */
  adcFailure: undefined as Error | undefined,
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(private readonly options: {credentials?: unknown}) {}
    async getClient() {
      if (this.options.credentials) {
        return {getAccessToken: async () => ({token: authState.jwtToken})};
      }
      if (authState.adcFailure) {
        throw authState.adcFailure;
      }
      return {getAccessToken: async () => ({token: authState.adcToken})};
    }
  },
}));

const SPEC_RESOURCE = 'projects/p/locations/l/apis/a/versions/v/specs/s';

/** Queues one successful JSON response per API Hub call, in order. */
function queueJson(...payloads: unknown[]): void {
  for (const payload of payloads) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(payload), {status: 200}),
    );
  }
}

/** The URL of the nth `fetch` call. */
function requestedUrl(nth: number): string {
  return String(vi.mocked(globalThis.fetch).mock.calls[nth][0]);
}

/** The `Authorization` header of the first `fetch` call. */
function sentAuthorization(): string | null {
  const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
  return new Headers(init?.headers).get('Authorization');
}

describe('APIHubClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    authState.adcToken = 'adc_token';
    authState.jwtToken = 'jwt_token';
    authState.adcFailure = undefined;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('endpoint', () => {
    it('sends every request to the public API Hub endpoint', async () => {
      const client = new APIHubClient({accessToken: 'token'});
      queueJson(
        {apis: []},
        {versions: ['projects/p/locations/l/apis/a/versions/v']},
        {specs: [SPEC_RESOURCE]},
        {contents: Buffer.from('spec').toString('base64')},
      );

      await client.listApis('p', 'l');
      await client.getSpecContent('projects/p/locations/l/apis/a');

      expect(requestedUrl(0)).toBe(
        'https://apihub.googleapis.com/v1/projects/p/locations/l/apis',
      );
      expect(requestedUrl(1)).toBe(
        'https://apihub.googleapis.com/v1/projects/p/locations/l/apis/a',
      );
      expect(requestedUrl(2)).toBe(
        'https://apihub.googleapis.com/v1/projects/p/locations/l/apis/a/versions/v',
      );
      expect(requestedUrl(3)).toBe(
        `https://apihub.googleapis.com/v1/${SPEC_RESOURCE}:contents`,
      );
    });
  });

  describe('credential precedence', () => {
    it('sends the access token when one is configured', async () => {
      queueJson({apis: []});

      await new APIHubClient({
        accessToken: 'explicit_token',
        serviceAccountJson: JSON.stringify({client_email: 'a@b.c'}),
      }).listApis('p', 'l');

      expect(sentAuthorization()).toBe('Bearer explicit_token');
    });

    it('signs with the service account when no access token is configured', async () => {
      queueJson({apis: []});

      await new APIHubClient({
        serviceAccountJson: JSON.stringify({
          client_email: 'a@b.c',
          private_key: 'key',
        }),
      }).listApis('p', 'l');

      expect(sentAuthorization()).toBe('Bearer jwt_token');
    });

    it('falls back to Application Default Credentials', async () => {
      queueJson({apis: []});

      await new APIHubClient().listApis('p', 'l');

      expect(sentAuthorization()).toBe('Bearer adc_token');
    });

    it('rejects when the resolved credential yields no token', async () => {
      authState.adcToken = undefined;

      await expect(new APIHubClient().listApis('p', 'l')).rejects.toThrow(
        'Please provide a service account or an access token to API Hub client.',
      );
    });

    it('keeps the credential library failure as the cause', async () => {
      const adcFailure = new Error('could not find the default credentials');
      authState.adcFailure = adcFailure;

      const rejection = await new APIHubClient()
        .listApis('p', 'l')
        .catch((e: unknown) => e);

      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).toHaveProperty('cause', adcFailure);
    });

    it('rejects malformed service account JSON', async () => {
      await expect(
        new APIHubClient({serviceAccountJson: 'not json'}).listApis('p', 'l'),
        // adk-python renders the parse failure as `f"{e}"`, which is the
        // message without the exception class, and so does this.
      ).rejects.toThrow(
        'Invalid service account JSON: Unexpected token \'o\', "not json" ' +
          'is not valid JSON',
      );
    });
  });

  describe('response payloads', () => {
    it('returns an empty list when the response names no apis', async () => {
      queueJson({});

      await expect(new APIHubClient().listApis('p', 'l')).resolves.toEqual([]);
    });

    it('returns an empty string when the spec response names no contents', async () => {
      queueJson({});

      await expect(
        new APIHubClient().getSpecContent(SPEC_RESOURCE),
      ).resolves.toBe('');
    });

    it('decodes multi-byte UTF-8 spec content', async () => {
      const spec = 'title: Café 版本 🌍';
      queueJson({contents: Buffer.from(spec, 'utf-8').toString('base64')});

      await expect(
        new APIHubClient().getSpecContent(SPEC_RESOURCE),
      ).resolves.toBe(spec);
    });

    it('reports a missing version list on the API', async () => {
      queueJson({name: 'projects/p/locations/l/apis/a'});

      await expect(
        new APIHubClient().getSpecContent('projects/p/locations/l/apis/a'),
      ).rejects.toThrow(
        'No versions found in API Hub resource: projects/p/locations/l/apis/a',
      );
    });

    it('reports a missing spec list on the version', async () => {
      queueJson({name: 'projects/p/locations/l/apis/a/versions/v'});

      await expect(
        new APIHubClient().getSpecContent(
          'projects/p/locations/l/apis/a/versions/v',
        ),
      ).rejects.toThrow(
        'No specs found in API Hub version: projects/p/locations/l/apis/a/versions/v',
      );
    });

    it('resolves the first version and the first spec that are listed', async () => {
      queueJson(
        {
          versions: [
            'projects/p/locations/l/apis/a/versions/v1',
            'projects/p/locations/l/apis/a/versions/v2',
          ],
        },
        {
          specs: [
            'projects/p/locations/l/apis/a/versions/v1/specs/s1',
            'projects/p/locations/l/apis/a/versions/v1/specs/s2',
          ],
        },
        {contents: Buffer.from('first spec').toString('base64')},
      );

      await expect(
        new APIHubClient().getSpecContent('projects/p/locations/l/apis/a'),
      ).resolves.toBe('first spec');
      expect(requestedUrl(1)).toBe(
        'https://apihub.googleapis.com/v1/projects/p/locations/l/apis/a/versions/v1',
      );
      expect(requestedUrl(2)).toBe(
        'https://apihub.googleapis.com/v1/projects/p/locations/l/apis/a/versions/v1/specs/s1:contents',
      );
    });
  });

  describe('path forms', () => {
    it('ignores a trailing slash', () => {
      expect(
        extractResourceName('projects/p/locations/l/apis/a/versions/v/'),
      ).toEqual({
        apiResourceName: 'projects/p/locations/l/apis/a',
        apiVersionResourceName: 'projects/p/locations/l/apis/a/versions/v',
        apiSpecResourceName: undefined,
      });
    });

    it('reads the resource path after api-hub/, not a matching segment before it', () => {
      expect(
        extractResourceName(
          'https://console.cloud.google.com/projects/console-p/api-hub/projects/p/locations/l/apis/a',
        ),
      ).toEqual({
        apiResourceName: 'projects/p/locations/l/apis/a',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      });
    });

    it('reads the project from the query when the path names none', () => {
      expect(
        extractResourceName(
          'https://console.cloud.google.com/apigee/api-hub/locations/l/apis/a?project=p',
        ),
      ).toEqual({
        apiResourceName: 'projects/p/locations/l/apis/a',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      });
    });

    it('treats everything after the first question mark as the query', () => {
      expect(
        extractResourceName(
          'https://console.cloud.google.com/apigee/api-hub/locations/l/apis/a?redirect=/page?tab=1&project=p',
        ),
      ).toEqual({
        apiResourceName: 'projects/p/locations/l/apis/a',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      });
    });

    it('ignores the query project when the path has a projects segment', () => {
      // adk-python reads `project=` only when the path carries no `projects`
      // segment at all, so a dangling `projects` segment is an error rather
      // than a reason to fall back.
      expect(() => extractResourceName('projects?project=p')).toThrow(
        'Project ID not found in URL or path in APIHubClient.',
      );
    });

    it('drops a spec id that no version id precedes', () => {
      expect(
        extractResourceName('projects/p/locations/l/apis/a/specs/s'),
      ).toEqual({
        apiResourceName: 'projects/p/locations/l/apis/a',
        apiVersionResourceName: undefined,
        apiSpecResourceName: undefined,
      });
    });
  });
});

describe('BaseAPIHubClient', () => {
  it('accepts a substitute implementation', async () => {
    class StaticSpecClient extends BaseAPIHubClient {
      override async getSpecContent(resourceName: string): Promise<string> {
        return `spec for ${resourceName}`;
      }
    }

    const client: BaseAPIHubClient = new StaticSpecClient();

    await expect(client.getSpecContent('my-api')).resolves.toBe(
      'spec for my-api',
    );
  });
});
