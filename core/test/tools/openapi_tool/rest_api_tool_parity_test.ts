/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApiParameter,
  AuthCredential,
  AuthCredentialTypes,
  Context,
  createRestApiTool,
  OperationEndpoint,
  ParsedOperation,
  RestApiTool,
  ToolAuthHandler,
  version,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  prepareRequestBody,
  prepareRequestParams,
} from '../../../src/tools/openapi_tool/rest_api_tool.js';

const BASE_URL = 'https://example.com';
const API_KEY_SCHEME: OpenAPIV3.SecuritySchemeObject = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
};

function apiParameter(
  originalName: string,
  paramLocation: string,
  name: string = originalName,
): ApiParameter {
  return {
    originalName,
    paramLocation,
    paramSchema: {type: 'string'},
    name,
    required: false,
  };
}

function endpointFor(path: string, baseUrl = BASE_URL): OperationEndpoint {
  return {baseUrl, path, method: 'GET'};
}

function mockOkFetch(): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: {get: () => 'text/plain'},
    text: async () => 'ok',
  });
}

function sentUrl(): string {
  return String(vi.mocked(globalThis.fetch).mock.calls[0][0]);
}

/** The headers of the first `fetch` call, read case-insensitively. */
function sentHeaders(): Headers {
  return new Headers(vi.mocked(globalThis.fetch).mock.calls[0][1]?.headers);
}

/** A `ToolAuthHandler` with no scheme, so `prepareAuthCredentials` is a no-op. */
function passthroughAuthHandler(): ToolAuthHandler {
  return new ToolAuthHandler({} as Context);
}

describe('RestApiTool adk-python parity', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('runAsync', () => {
    it('reports an HTTP error status as a tool error', async () => {
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpointFor('/test'),
        {responses: {}},
      );
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: {get: () => 'text/plain'},
        text: async () => 'Internal Server Error',
      });

      const result = await tool.runAsync({
        args: {},
        toolContext: {} as Context,
      });

      expect(result).toEqual({
        error:
          'Tool test_tool execution failed. Analyze this execution error and' +
          ' your inputs. Retry with adjustments if applicable. But make sure' +
          " don't retry more than 3 times. Execution Error: Status Code: 500," +
          ' Internal Server Error',
      });
    });

    it('fills a missing required parameter from its schema default', async () => {
      const operation: OpenAPIV3.OperationObject = {
        operationId: 'test_op',
        responses: {},
        parameters: [
          {
            name: 'userId',
            in: 'path',
            required: true,
            schema: {type: 'string', default: 'me'},
          },
        ],
      };
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpointFor('/users/{userId}/messages'),
        operation,
      );
      mockOkFetch();

      await tool.runAsync({args: {}, toolContext: {} as Context});

      expect(sentUrl()).toBe('https://example.com/users/me/messages');
    });

    it('sends the ADK User-Agent header', async () => {
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpointFor('/test'),
        {responses: {}},
      );
      mockOkFetch();

      await tool.runAsync({args: {}, toolContext: {} as Context});

      expect(sentHeaders().get('User-Agent')).toBe(
        `google-adk/${version} (tool: test_tool)`,
      );
    });

    it('sends the credential additional headers', async () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {},
          additionalHeaders: {'x-goog-user-project': 'test-project'},
        },
      };
      const handler = passthroughAuthHandler();
      vi.spyOn(handler, 'prepareAuthCredentials').mockResolvedValue({
        state: 'done',
        authCredential: credential,
      });
      vi.spyOn(ToolAuthHandler, 'fromToolContext').mockReturnValue(handler);

      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpointFor('/test'),
        {responses: {}},
        API_KEY_SCHEME,
        credential,
      );
      mockOkFetch();

      await tool.runAsync({args: {}, toolContext: {} as Context});

      expect(sentHeaders().get('x-goog-user-project')).toBe('test-project');
    });
  });

  describe('prepareRequestParams', () => {
    it('keeps falsy query values and drops a null one', () => {
      const parameters = [
        apiParameter('flag', 'query'),
        apiParameter('offset', 'query'),
        apiParameter('empty_param', 'query'),
        apiParameter('cursor', 'query'),
      ];

      const result = prepareRequestParams(endpointFor('/test'), parameters, {
        flag: false,
        offset: 0,
        empty_param: '',
        cursor: null,
      });

      const query = new URL(result.url).searchParams;
      expect(query.get('flag')).toBe('false');
      expect(query.get('offset')).toBe('0');
      expect(query.get('empty_param')).toBe('');
      expect(query.has('cursor')).toBe(false);
    });

    // `fetch` has no cookie jar, so a `Cookie` request header is the faithful
    // TypeScript equivalent of httpx's `cookies=` keyword argument.
    it('sends cookie parameters in the Cookie header', () => {
      const single = prepareRequestParams(
        endpointFor('/test'),
        [apiParameter('session_id', 'cookie')],
        {session_id: 'cookie_value'},
      );
      expect(single.headers['Cookie']).toBe('session_id=cookie_value');

      const pair = prepareRequestParams(
        endpointFor('/test'),
        [apiParameter('a', 'cookie'), apiParameter('b', 'cookie')],
        {a: '1', b: '2'},
      );
      expect(pair.headers['Cookie']).toBe('a=1; b=2');
    });

    it('strips a trailing slash from the base URL but keeps an empty one', () => {
      const trailing = prepareRequestParams(
        endpointFor('/trailing', 'https://example.com/'),
        [],
        {},
      );
      expect(trailing.url).toBe('https://example.com/trailing');

      const noBase = prepareRequestParams(endpointFor('/no_base', ''), [], {});
      expect(noBase.url).toBe('/no_base');
    });

    it('strips a fragment from the path template', () => {
      const result = prepareRequestParams(endpointFor('/api#fragment'), [], {});

      expect(result.url).toBe('https://example.com/api');
    });

    it('splits a path template carrying both a query string and a fragment', () => {
      const path =
        '/v2/projects/my-proj/locations/us-central1/integrations/' +
        'ExecuteConnection:execute?triggerId=api_trigger/ExecuteConnection' +
        '#POST_files';

      const result = prepareRequestParams(endpointFor(path), [], {});

      const url = new URL(result.url);
      expect(url.searchParams.get('triggerId')).toBe(
        'api_trigger/ExecuteConnection',
      );
      expect(url.hash).toBe('');
    });

    it('prefers a declared query parameter over one embedded in the path', () => {
      const result = prepareRequestParams(
        endpointFor('/api?key=embedded'),
        [apiParameter('key', 'query')],
        {key: 'explicit'},
      );

      expect(new URL(result.url).searchParams.getAll('key')).toEqual([
        'explicit',
      ]);
    });
  });

  describe('prepareRequestBody', () => {
    it('sends an application/octet-stream body', () => {
      const requestBody: OpenAPIV3.RequestBodyObject = {
        content: {
          'application/octet-stream': {
            schema: {type: 'string', format: 'binary'},
          },
        },
      };
      const payload = new Uint8Array([1, 2, 3]);
      const headers: Record<string, string> = {};

      const body = prepareRequestBody(requestBody, payload, {}, headers);

      expect(body).toBe(payload);
      expect(headers['Content-Type']).toBe('application/octet-stream');
    });
  });

  describe('setDefaultHeaders', () => {
    it('merges the default headers into the request', async () => {
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpointFor('/test'),
        {responses: {}},
      );
      tool.setDefaultHeaders({'developer-token': 'token'});
      mockOkFetch();

      await tool.runAsync({args: {}, toolContext: {} as Context});

      expect(sentHeaders().get('developer-token')).toBe('token');
    });

    it('never overrides a per-request header with a default', async () => {
      const operation: OpenAPIV3.OperationObject = {
        operationId: 'test_op',
        responses: {},
        parameters: [
          {name: 'User-Agent', in: 'header', schema: {type: 'string'}},
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {type: 'object', properties: {message: {type: 'string'}}},
            },
          },
        },
      };
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpointFor('/test'),
        operation,
        undefined,
        undefined,
        {preservePropertyNames: true},
      );
      tool.setDefaultHeaders({
        'Content-Type': 'text/plain',
        'developer-token': 'token',
        'User-Agent': 'custom-default',
      });
      mockOkFetch();

      await tool.runAsync({
        args: {'User-Agent': 'api-client', message: 'value'},
        toolContext: {} as Context,
      });

      const headers = sentHeaders();
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(headers.get('developer-token')).toBe('token');
      expect(headers.get('User-Agent')).toBe('api-client');
    });
  });

  describe('construction', () => {
    it('truncates the tool name to 60 characters', () => {
      const tool = new RestApiTool(
        'a'.repeat(70),
        'description',
        endpointFor('/test'),
        {responses: {}},
      );

      expect(tool.name).toHaveLength(60);
    });

    it('declares the pre-parsed parameters, not the operation ones', () => {
      const parsed: ParsedOperation = {
        name: 'parsed_name_that_is_not_the_tool_name',
        description: 'Parsed description that is not the tool description.',
        endpoint: endpointFor('/pets'),
        operation: {
          operationId: 'listPets',
          responses: {},
          parameters: [
            {name: 'fromOperation', in: 'query', schema: {type: 'string'}},
          ],
        },
        parameters: [apiParameter('fromParsed', 'query', 'from_parsed')],
      };

      const declaration = createRestApiTool(parsed)._getDeclaration();

      if (!declaration?.parameters?.properties) {
        expect.fail('the declaration exposes no parameter properties');
      }
      expect(Object.keys(declaration.parameters.properties)).toEqual([
        'from_parsed',
      ]);
    });

    it('carries the parsed operation credential onto the tool', async () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'parsed-operation-key',
      };
      const parsed: ParsedOperation = {
        name: 'list_pets',
        description: 'List pets.',
        endpoint: endpointFor('/pets'),
        operation: {operationId: 'listPets', responses: {}},
        parameters: [],
        authScheme: API_KEY_SCHEME,
        authCredential: credential,
      };
      const fromToolContext = vi
        .spyOn(ToolAuthHandler, 'fromToolContext')
        .mockReturnValue(passthroughAuthHandler());
      mockOkFetch();

      await createRestApiTool(parsed).runAsync({
        args: {},
        toolContext: {} as Context,
      });

      expect(fromToolContext.mock.calls[0][2]).toBe(credential);
    });

    it('renders identity in toString and never the credential', () => {
      const tool = new RestApiTool(
        'test_tool',
        'test description',
        endpointFor('/test'),
        {responses: {}},
        API_KEY_SCHEME,
        {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'sk-live-secret-api-key-12345',
        },
      );

      const rendered = String(tool);

      expect(rendered).toContain('name="test_tool"');
      expect(rendered).toContain('description="test description"');
      expect(rendered).toContain('endpoint=');
      expect(rendered).not.toContain('sk-live-secret-api-key-12345');
      expect(rendered).not.toContain('authCredential');
    });
  });
});
