/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleAuth} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  APIHubClient,
  BaseAPIHubClient,
  extractResourceName,
} from '../../../../src/tools/apihub_tool/clients/apihub_client.js';

function createMockJsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {'content-type': 'application/json'},
  });
}

describe('APIHubClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractResourceName', () => {
    it('test_extract_resource_name_from_api_resource_path', () => {
      const client = new APIHubClient({accessToken: 'test-token'});
      const result = client.extractResourceName(
        'projects/my-project/locations/us-central1/apis/my-api',
      );
      expect(result).toEqual([
        'projects/my-project/locations/us-central1/apis/my-api',
        undefined,
        undefined,
      ]);
    });

    it('test_extract_resource_name_from_version_resource_path', () => {
      const result = extractResourceName(
        'projects/my-project/locations/us-central1/apis/my-api/versions/v1',
      );
      expect(result).toEqual([
        'projects/my-project/locations/us-central1/apis/my-api',
        'projects/my-project/locations/us-central1/apis/my-api/versions/v1',
        undefined,
      ]);
    });

    it('test_extract_resource_name_from_spec_resource_path', () => {
      const result = extractResourceName(
        'projects/my-project/locations/us-central1/apis/my-api/versions/v1/specs/my-spec',
      );
      expect(result).toEqual([
        'projects/my-project/locations/us-central1/apis/my-api',
        'projects/my-project/locations/us-central1/apis/my-api/versions/v1',
        'projects/my-project/locations/us-central1/apis/my-api/versions/v1/specs/my-spec',
      ]);
    });

    it('test_extract_resource_name_from_ui_url', () => {
      const result = extractResourceName(
        'https://console.cloud.google.com/apigee/api-hub/locations/us-central1/apis/my-api/versions/v1/specs/my-spec?project=my-ui-project',
      );
      expect(result).toEqual([
        'projects/my-ui-project/locations/us-central1/apis/my-api',
        'projects/my-ui-project/locations/us-central1/apis/my-api/versions/v1',
        'projects/my-ui-project/locations/us-central1/apis/my-api/versions/v1/specs/my-spec',
      ]);
    });

    it('test_extract_resource_name_missing_project', () => {
      expect(() =>
        extractResourceName('locations/us-central1/apis/my-api'),
      ).toThrow(/Project ID not found in URL or path in APIHubClient/);
    });

    it('test_extract_resource_name_missing_location', () => {
      expect(() =>
        extractResourceName('projects/my-project/apis/my-api'),
      ).toThrow(/Location not found in URL or path in APIHubClient/);
    });

    it('test_extract_resource_name_missing_api_id', () => {
      expect(() =>
        extractResourceName('projects/my-project/locations/us-central1'),
      ).toThrow(/API id not found in URL or path in APIHubClient/);
    });
  });

  describe('getSpecContent', () => {
    it('test_get_spec_content_from_api_path', async () => {
      const client = new APIHubClient({accessToken: 'test-token'});
      const specText = 'openapi: 3.0.0\ninfo:\n  title: Sample API';
      const base64Spec = Buffer.from(specText, 'utf-8').toString('base64');

      fetchSpy
        .mockResolvedValueOnce(
          createMockJsonResponse({
            versions: [
              'projects/my-project/locations/us-central1/apis/my-api/versions/v1',
            ],
          }),
        )
        .mockResolvedValueOnce(
          createMockJsonResponse({
            specs: [
              'projects/my-project/locations/us-central1/apis/my-api/versions/v1/specs/spec1',
            ],
          }),
        )
        .mockResolvedValueOnce(
          createMockJsonResponse({
            contents: base64Spec,
          }),
        );

      const content = await client.getSpecContent(
        'projects/my-project/locations/us-central1/apis/my-api',
      );

      expect(content).toBe(specText);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'https://apihub.googleapis.com/v1/projects/my-project/locations/us-central1/apis/my-api',
        expect.objectContaining({
          headers: {
            accept: 'application/json, text/plain, */*',
            Authorization: 'Bearer test-token',
          },
        }),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        'https://apihub.googleapis.com/v1/projects/my-project/locations/us-central1/apis/my-api/versions/v1',
        expect.any(Object),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        3,
        'https://apihub.googleapis.com/v1/projects/my-project/locations/us-central1/apis/my-api/versions/v1/specs/spec1:contents',
        expect.any(Object),
      );
    });

    it('test_get_spec_content_from_api_no_versions', async () => {
      const client = new APIHubClient({accessToken: 'test-token'});
      fetchSpy.mockResolvedValueOnce(createMockJsonResponse({versions: []}));

      await expect(
        client.getSpecContent(
          'projects/my-project/locations/us-central1/apis/my-api',
        ),
      ).rejects.toThrow(
        'No versions found in API Hub resource: projects/my-project/locations/us-central1/apis/my-api',
      );
    });

    it('test_get_spec_content_from_version_path', async () => {
      const client = new APIHubClient({accessToken: 'test-token'});
      const specText = '{"swagger": "2.0"}';
      const base64Spec = Buffer.from(specText, 'utf-8').toString('base64');

      fetchSpy
        .mockResolvedValueOnce(
          createMockJsonResponse({
            specs: [
              'projects/my-project/locations/us-central1/apis/my-api/versions/v1/specs/spec1',
            ],
          }),
        )
        .mockResolvedValueOnce(
          createMockJsonResponse({
            contents: base64Spec,
          }),
        );

      const content = await client.getSpecContent(
        'projects/my-project/locations/us-central1/apis/my-api/versions/v1',
      );

      expect(content).toBe(specText);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('test_get_spec_content_from_version_no_specs', async () => {
      const client = new APIHubClient({accessToken: 'test-token'});
      fetchSpy.mockResolvedValueOnce(createMockJsonResponse({specs: []}));

      await expect(
        client.getSpecContent(
          'projects/my-project/locations/us-central1/apis/my-api/versions/v1',
        ),
      ).rejects.toThrow(
        'No specs found in API Hub version: projects/my-project/locations/us-central1/apis/my-api/versions/v1',
      );
    });

    it('test_get_spec_content_from_spec_path', async () => {
      const client = new APIHubClient({accessToken: 'test-token'});
      const specText = 'openapi: 3.1.0';
      const base64Spec = Buffer.from(specText, 'utf-8').toString('base64');

      fetchSpy.mockResolvedValueOnce(
        createMockJsonResponse({contents: base64Spec}),
      );

      const content = await client.getSpecContent(
        'projects/my-project/locations/us-central1/apis/my-api/versions/v1/specs/spec1',
      );

      expect(content).toBe(specText);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('test_fetch_spec_empty_contents', async () => {
      const client = new APIHubClient({accessToken: 'test-token'});
      fetchSpy.mockResolvedValueOnce(createMockJsonResponse({}));

      const content = await client.fetchSpec(
        'projects/my-project/locations/us-central1/apis/my-api/versions/v1/specs/spec1',
      );
      expect(content).toBe('');
    });
  });

  describe('listApis, getApi, and getApiVersion', () => {
    it('test_list_apis', async () => {
      const client = new APIHubClient({accessToken: 'test-token'});
      const expectedApis = [{name: 'projects/p/locations/l/apis/api1'}];
      fetchSpy.mockResolvedValueOnce(
        createMockJsonResponse({apis: expectedApis}),
      );

      const apis = await client.listApis('p', 'l');
      expect(apis).toEqual(expectedApis);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://apihub.googleapis.com/v1/projects/p/locations/l/apis',
        expect.objectContaining({
          method: 'GET',
          headers: {
            accept: 'application/json, text/plain, */*',
            Authorization: 'Bearer test-token',
          },
        }),
      );
    });

    it('test_get_api', async () => {
      const client = new APIHubClient({accessToken: 'test-token'});
      const expectedApi = {
        name: 'projects/p/locations/l/apis/api1',
        versions: ['projects/p/locations/l/apis/api1/versions/v1'],
      };
      fetchSpy.mockResolvedValueOnce(createMockJsonResponse(expectedApi));

      const api = await client.getApi('projects/p/locations/l/apis/api1');
      expect(api).toEqual(expectedApi);
    });

    it('test_get_api_version', async () => {
      const client = new APIHubClient({accessToken: 'test-token'});
      const expectedVersion = {
        name: 'projects/p/locations/l/apis/api1/versions/v1',
        specs: ['projects/p/locations/l/apis/api1/versions/v1/specs/s1'],
      };
      fetchSpy.mockResolvedValueOnce(createMockJsonResponse(expectedVersion));

      const version = await client.getApiVersion(
        'projects/p/locations/l/apis/api1/versions/v1',
      );
      expect(version).toEqual(expectedVersion);
    });

    it('test_http_error_status_throws', async () => {
      const client = new APIHubClient({accessToken: 'test-token'});
      fetchSpy.mockResolvedValueOnce(createMockJsonResponse({}, 404));

      await expect(
        client.getApi('projects/p/locations/l/apis/missing'),
      ).rejects.toThrow('API Hub request failed with status 404');
    });
  });

  describe('authentication and getAccessToken', () => {
    it('test_get_access_token_with_explicit_access_token', async () => {
      const client = new APIHubClient({accessToken: 'direct-token'});
      expect(await client.getAccessToken()).toBe('direct-token');
    });

    it('test_get_access_token_uses_cached_credential', async () => {
      const mockAuth = {
        getAccessToken: vi.fn().mockResolvedValue('resolved-auth-token'),
      } as unknown as GoogleAuth;

      const client = new APIHubClient({
        serviceAccountJson: JSON.stringify({
          client_email: 'sa@example.iam.gserviceaccount.com',
          private_key: 'fake-key',
        }),
        auth: mockAuth,
      });

      const firstToken = await client.getAccessToken();
      const secondToken = await client.getAccessToken();

      expect(firstToken).toBe('resolved-auth-token');
      expect(secondToken).toBe('resolved-auth-token');
      expect(mockAuth.getAccessToken).toHaveBeenCalledTimes(1);
    });

    it('test_get_access_token_invalid_service_account_json', async () => {
      const client = new APIHubClient({
        serviceAccountJson: '{not-valid-json',
      });

      await expect(client.getAccessToken()).rejects.toThrow(
        /Invalid service account JSON:/,
      );
    });

    it('test_get_access_token_missing_credentials_throws', async () => {
      const mockAuth = {
        getAccessToken: vi.fn().mockResolvedValue(null),
      } as unknown as GoogleAuth;

      const client = new APIHubClient({auth: mockAuth});
      await expect(client.getAccessToken()).rejects.toThrow(
        'Please provide a service account or an access token to API Hub client.',
      );
    });
  });

  describe('BaseAPIHubClient', () => {
    it('test_custom_subclass_implementation', async () => {
      class CustomClient extends BaseAPIHubClient {
        override getSpecContent(resourceName: string): string {
          return `spec-for-${resourceName}`;
        }
      }

      const client = new CustomClient();
      expect(client.getSpecContent('my-resource')).toBe('spec-for-my-resource');
    });
  });
});
