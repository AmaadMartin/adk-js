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
  createRestApiToolFromJson,
  createSession,
  InvocationContext,
  LlmAgent,
  OpenApiSpecParser,
  OperationParser,
  ParsedOperation,
  PluginManager,
  RestApiTool,
  ToolAuthHandler,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  applyCredential,
  createApiKeyScheme,
} from '../../../src/tools/openapi_tool/auth/auth_helpers.js';
import {
  prepareRequestBody,
  prepareRequestParams,
} from '../../../src/tools/openapi_tool/rest_api_tool.js';

describe('RestApiTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should configure credential key', () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    tool.configureCredentialKey('my-credential-key');

    expect((tool as unknown as {credentialKey: string}).credentialKey).toBe(
      'my-credential-key',
    );
  });

  it('should apply headers from provider', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const headerProvider = vi
      .fn()
      .mockReturnValue({'X-Custom-Header': 'custom-value'});
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
      undefined,
      undefined,
      {headerProvider},
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    const mockContext = {};
    await tool.runAsync({
      args: {},
      toolContext: mockContext as unknown as Context,
    });

    expect(headerProvider).toHaveBeenCalledWith(mockContext);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({'X-Custom-Header': 'custom-value'}),
      }),
    );
  });

  it('should stringify object body', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'POST',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    // Mock operationParser to return a body parameter
    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'body', originalName: 'body', paramLocation: 'body'},
    ];

    await tool.runAsync({
      args: {body: {foo: 'bar'}},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: JSON.stringify({foo: 'bar'}),
      }),
    );
  });

  it('should replace path parameters', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/users/{id}',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'id', originalName: 'id', paramLocation: 'path'},
    ];

    await tool.runAsync({
      args: {id: '123'},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://api.example.com/users/123',
      expect.anything(),
    );
  });

  it('should stringify bodyData', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'POST',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'user', originalName: 'user', paramLocation: 'body'},
    ];

    await tool.runAsync({
      args: {user: {name: 'Alice'}},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: JSON.stringify({user: {name: 'Alice'}}),
      }),
    );
  });

  it('should return pending if auth is pending', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    const mockAuthHandler = {
      prepareAuthCredentials: async () => ({state: 'pending'}),
    };
    vi.spyOn(ToolAuthHandler, 'fromToolContext').mockReturnValue(
      mockAuthHandler as unknown as ToolAuthHandler,
    );

    const result = await tool.runAsync({
      args: {},
      toolContext: {} as unknown as Context,
    });

    expect(result).toEqual({
      pending: true,
      message: 'Needs your authorization to access your data.',
    });
  });

  it('should add header parameters', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'x-trace-id', originalName: 'X-Trace-Id', paramLocation: 'header'},
    ];

    await tool.runAsync({
      args: {'x-trace-id': 'trace-123'},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({'X-Trace-Id': 'trace-123'}),
      }),
    );
  });

  it('should get declaration', () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    const mockSchema = {type: 'object', properties: {}};
    (
      tool as unknown as {operationParser: {getJsonSchema: () => unknown}}
    ).operationParser.getJsonSchema = () => mockSchema;

    const declaration = (
      tool as unknown as {_getDeclaration: () => unknown}
    )._getDeclaration();

    expect(declaration).toEqual({
      name: 'test_tool',
      description: 'description',
      parameters: mockSchema,
    });
  });

  it('should extract query parameters from path', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test?existing=param',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'new_param', originalName: 'new_param', paramLocation: 'query'},
    ];

    await tool.runAsync({
      args: {new_param: 'value'},
      toolContext: {} as unknown as Context,
    });

    // Verify URL contains both parameters
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('http://api.example.com/test'),
      expect.anything(),
    );
    const calledUrl = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain('existing=param');
    expect(calledUrl).toContain('new_param=value');
  });

  it('should handle application/x-www-form-urlencoded body', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'POST',
    };
    const operation: OpenAPIV3.OperationObject = {
      responses: {},
      requestBody: {
        content: {
          'application/x-www-form-urlencoded': {
            schema: {type: 'object'},
          },
        },
      },
    };
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'foo', originalName: 'foo', paramLocation: 'body'},
      {name: 'baz', originalName: 'baz', paramLocation: 'body'},
    ];

    await tool.runAsync({
      args: {foo: 'bar', baz: 'qux'},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.any(URLSearchParams),
      }),
    );
    const calledBody = vi.mocked(globalThis.fetch).mock.calls[0][1]!
      .body as URLSearchParams;
    expect(calledBody.get('foo')).toBe('bar');
    expect(calledBody.get('baz')).toBe('qux');
  });

  it('should handle multipart/form-data body', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'POST',
    };
    const operation: OpenAPIV3.OperationObject = {
      responses: {},
      requestBody: {
        content: {
          'multipart/form-data': {
            schema: {type: 'object'},
          },
        },
      },
    };
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'foo', originalName: 'foo', paramLocation: 'body'},
      {name: 'file', originalName: 'file', paramLocation: 'body'},
    ];

    await tool.runAsync({
      args: {foo: 'bar', file: 'content'},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.any(FormData),
      }),
    );
    const calledBody = vi.mocked(globalThis.fetch).mock.calls[0][1]!
      .body as FormData;
    expect(calledBody.get('foo')).toBe('bar');
    expect(calledBody.get('file')).toBe('content');
  });

  it('should handle fetch error', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await tool.runAsync({
      args: {},
      toolContext: {} as unknown as Context,
    });

    expect(result).toEqual({
      error: 'Failed to execute API call: Network error',
    });
  });

  it('should apply auth credentials to fetch request', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const authScheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    };
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
      authScheme,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    const mockAuthHandler = {
      prepareAuthCredentials: async () => ({
        state: 'done',
        authCredential: {apiKey: 'secret_key'},
      }),
    };
    vi.spyOn(ToolAuthHandler, 'fromToolContext').mockReturnValue(
      mockAuthHandler as unknown as ToolAuthHandler,
    );

    await tool.runAsync({
      args: {},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({'X-API-Key': 'secret_key'}),
      }),
    );
  });

  it('should fallback to JSON if no requestBody in spec', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'POST',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    (
      tool as unknown as {operationParser: {getParameters: () => unknown[]}}
    ).operationParser.getParameters = () => [
      {name: 'body', originalName: 'body', paramLocation: 'body'},
    ];

    await tool.runAsync({
      args: {body: {foo: 'bar'}},
      toolContext: {} as unknown as Context,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({'Content-Type': 'application/json'}),
        body: JSON.stringify({foo: 'bar'}),
      }),
    );
  });

  it('should return JSON response if content-type is application/json', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    const jsonResponse = {result: 'success'};
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name === 'content-type' ? 'application/json' : null,
      },
      json: async () => jsonResponse,
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: {} as unknown as Context,
    });

    expect(result).toEqual(jsonResponse);
  });

  it('should configure auth scheme and credential via setters', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {responses: {}};
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    const authScheme = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    } as unknown as OpenAPIV3.SecuritySchemeObject;
    const authCredential = {apiKey: 'test-key'} as unknown as AuthCredential;

    tool.configureAuthScheme(authScheme);
    tool.configureAuthCredential(authCredential);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    const mockAuthHandler = {
      prepareAuthCredentials: async () => ({
        state: 'done',
        authCredential,
      }),
    };
    const spy = vi
      .spyOn(ToolAuthHandler, 'fromToolContext')
      .mockReturnValue(mockAuthHandler as unknown as ToolAuthHandler);

    await tool.runAsync({
      args: {},
      toolContext: {} as unknown as Context,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      authScheme,
      authCredential,
      expect.anything(),
    );
  });
});

describe('RestApiTool Utilities', () => {
  describe('createRestApiTool', () => {
    it('should successfully create a RestApiTool instance', () => {
      const endpoint = {
        baseUrl: 'http://api.example.com',
        path: '/test',
        method: 'GET',
      };
      const operation: OpenAPIV3.OperationObject = {responses: {}};
      const parsed = {
        name: 'test_tool',
        description: 'description',
        endpoint,
        operation,
        parameters: [],
      };

      const tool = createRestApiTool(parsed);
      expect(tool).toBeInstanceOf(RestApiTool);
      expect(tool.name).toBe('test_tool');
      expect(tool.description).toBe('description');
    });
  });

  describe('prepareRequestParams', () => {
    it('should map query, path, and header parameters correctly', () => {
      const endpoint = {
        baseUrl: 'http://api.example.com',
        path: '/users/{userId}/posts',
        method: 'GET',
      };
      const parameters = [
        {
          name: 'user_id',
          originalName: 'userId',
          paramLocation: 'path',
          paramSchema: {},
          required: true,
        },
        {
          name: 'q',
          originalName: 'q',
          paramLocation: 'query',
          paramSchema: {},
          required: false,
        },
        {
          name: 'x_trace_id',
          originalName: 'X-Trace-Id',
          paramLocation: 'header',
          paramSchema: {},
          required: false,
        },
      ];
      const args = {
        user_id: '123',
        q: 'search query',
        x_trace_id: 'trace-456',
      };

      const result = prepareRequestParams(endpoint, parameters, args);

      expect(result.url).toBe(
        'http://api.example.com/users/123/posts?q=search+query',
      );
      expect(result.headers).toEqual({
        'X-Trace-Id': 'trace-456',
      });
    });

    it('should ignore arguments that are not in parameters spec', () => {
      const endpoint = {
        baseUrl: 'http://api.example.com',
        path: '/users/{userId}/posts',
        method: 'GET',
      };
      const parameters = [
        {
          name: 'user_id',
          originalName: 'userId',
          paramLocation: 'path',
          paramSchema: {},
          required: true,
        },
      ];
      const args = {
        user_id: '123',
        extra_arg: 'should be ignored',
      };

      const result = prepareRequestParams(endpoint, parameters, args);

      expect(result.url).toBe('http://api.example.com/users/123/posts');
      expect(result.headers).toEqual({});
    });

    describe('path parameter encoding', () => {
      const usersEndpoint = {
        baseUrl: 'http://api.example.com',
        path: '/v1/users/{user_id}',
        method: 'GET',
      };
      const userIdParameters: ApiParameter[] = [
        {
          name: 'user_id',
          originalName: 'user_id',
          paramLocation: 'path',
          paramSchema: {},
          required: true,
        },
      ];

      it('should percent-encode path traversal sequences in path parameter values', () => {
        const result = prepareRequestParams(usersEndpoint, userIdParameters, {
          user_id: '../../admin/export',
        });

        expect(result.url).toBe(
          'http://api.example.com/v1/users/..%2F..%2Fadmin%2Fexport',
        );
        expect(new URL(result.url).pathname).toBe(
          '/v1/users/..%2F..%2Fadmin%2Fexport',
        );
      });

      it('should not let a path parameter value smuggle query parameters', () => {
        const result = prepareRequestParams(usersEndpoint, userIdParameters, {
          user_id: 'x?role=admin&debug=true',
        });

        expect(result.url).toBe(
          'http://api.example.com/v1/users/x%3Frole%3Dadmin%26debug%3Dtrue',
        );
        expect(new URL(result.url).searchParams.get('role')).toBeNull();
        expect([...new URL(result.url).searchParams.keys()]).toEqual([]);
      });

      it('should not attach the credential to a traversed path', () => {
        const result = prepareRequestParams(usersEndpoint, userIdParameters, {
          user_id: '../../admin/export',
        });

        const withKey = applyCredential(
          result.url,
          {},
          {authType: AuthCredentialTypes.API_KEY, apiKey: 'test-api-key'},
          createApiKeyScheme('key', 'query'),
        );

        expect(new URL(withKey).pathname).toBe(
          '/v1/users/..%2F..%2Fadmin%2Fexport',
        );
        expect(new URL(withKey).searchParams.get('key')).toBe('test-api-key');
      });

      it('should merge declared query parameters with an encoded path value', () => {
        const parameters: ApiParameter[] = [
          ...userIdParameters,
          {
            name: 'q',
            originalName: 'q',
            paramLocation: 'query',
            paramSchema: {},
            required: false,
          },
        ];

        const result = prepareRequestParams(usersEndpoint, parameters, {
          user_id: 'a/b',
          q: 'search term',
        });

        expect(result.url).toBe(
          'http://api.example.com/v1/users/a%2Fb?q=search+term',
        );
        expect(new URL(result.url).searchParams.get('q')).toBe('search term');
      });

      it('should reject a path parameter value that is a relative path segment', () => {
        expect(() =>
          prepareRequestParams(usersEndpoint, userIdParameters, {
            user_id: '..',
          }),
        ).toThrow(/relative path segments/);
      });

      it('should reject a single-dot path parameter value', () => {
        expect(() =>
          prepareRequestParams(usersEndpoint, userIdParameters, {
            user_id: '.',
          }),
        ).toThrow(
          "Invalid value for path parameter 'user_id': relative path " +
            "segments ('.' and '..') are not allowed.",
        );
      });

      it('should not substitute a path parameter into the base URL host', () => {
        const endpoint = {
          baseUrl: 'https://{region}.api.example.com',
          path: '/v1/data',
          method: 'GET',
        };
        const parameters: ApiParameter[] = [
          {
            name: 'region',
            originalName: 'region',
            paramLocation: 'path',
            paramSchema: {},
            required: true,
          },
        ];

        const result = prepareRequestParams(endpoint, parameters, {
          region: 'evil.attacker.com/',
        });

        expect(result.url).toBe('https://{region}.api.example.com/v1/data');
        expect(result.url).not.toContain('evil.attacker.com');
      });

      it('should keep a path parameter off a parsed spec\u2019s resolved host', () => {
        const spec: OpenAPIV3.Document = {
          openapi: '3.0.0',
          info: {title: 'Server API', version: '1.0.0'},
          servers: [
            {
              url: 'https://{region}.api.example.com',
              variables: {region: {default: 'us-central1'}},
            },
          ],
          paths: {
            '/v1/data': {
              get: {
                operationId: 'getData',
                parameters: [
                  {
                    name: 'region',
                    in: 'path',
                    required: true,
                    schema: {type: 'string'},
                  },
                ],
                responses: {},
              },
            },
          },
        };
        const parsed = new OpenApiSpecParser().parse(spec);

        const result = prepareRequestParams(
          parsed[0].endpoint,
          parsed[0].parameters,
          {region: 'evil.attacker.com/'},
        );

        expect(new URL(result.url).host).toBe('us-central1.api.example.com');
        expect(result.url).toBe('https://us-central1.api.example.com/v1/data');
      });

      it('should encode reserved characters in path parameter values', () => {
        const result = prepareRequestParams(usersEndpoint, userIdParameters, {
          user_id: 'a b#c&d=e',
        });

        expect(result.url).toBe(
          'http://api.example.com/v1/users/a%20b%23c%26d%3De',
        );
      });

      it('should not expand dollar patterns from a path parameter value', () => {
        const result = prepareRequestParams(usersEndpoint, userIdParameters, {
          user_id: 'a$&b',
        });

        expect(result.url).toBe('http://api.example.com/v1/users/a%24%26b');
      });

      it('should encode a space in a path parameter value', () => {
        const result = prepareRequestParams(usersEndpoint, userIdParameters, {
          user_id: 'John Doe',
        });

        expect(result.url).toBe('http://api.example.com/v1/users/John%20Doe');
      });

      it('should encode non-ASCII characters in a path parameter value', () => {
        const result = prepareRequestParams(usersEndpoint, userIdParameters, {
          user_id: 'café',
        });

        expect(result.url).toBe('http://api.example.com/v1/users/caf%C3%A9');
      });

      it('should round-trip a value made of reserved characters', () => {
        const value = "a/b?c#d&e=f%g$&h'i";

        const result = prepareRequestParams(usersEndpoint, userIdParameters, {
          user_id: value,
        });

        expect(result.url).toBe(
          'http://api.example.com/v1/users/' +
            "a%2Fb%3Fc%23d%26e%3Df%25g%24%26h'i",
        );
        const segment = new URL(result.url).pathname.split('/').pop();
        if (segment === undefined) expect.fail('the URL had no path segment');
        expect(decodeURIComponent(segment)).toBe(value);
      });

      it('should stringify non-string path parameter values', () => {
        expect(
          prepareRequestParams(usersEndpoint, userIdParameters, {user_id: 123})
            .url,
        ).toBe('http://api.example.com/v1/users/123');
        expect(
          prepareRequestParams(usersEndpoint, userIdParameters, {user_id: true})
            .url,
        ).toBe('http://api.example.com/v1/users/true');
      });

      it('should substitute every occurrence of a repeated path placeholder', () => {
        const endpoint = {
          baseUrl: 'http://api.example.com',
          path: '/a/{id}/b/{id}',
          method: 'GET',
        };
        const parameters: ApiParameter[] = [
          {
            name: 'id',
            originalName: 'id',
            paramLocation: 'path',
            paramSchema: {},
            required: true,
          },
        ];

        const result = prepareRequestParams(endpoint, parameters, {id: '7'});

        expect(result.url).toBe('http://api.example.com/a/7/b/7');
      });

      it('should leave a path placeholder literal when no argument is supplied', () => {
        const endpoint = {
          baseUrl: 'http://api.example.com',
          path: '/users/{userId}',
          method: 'GET',
        };

        const result = prepareRequestParams(endpoint, userIdParameters, {});

        expect(result.url).toBe('http://api.example.com/users/{userId}');
      });

      it('should not resolve a placeholder from Object.prototype', () => {
        const endpoint = {
          baseUrl: 'http://api.example.com',
          path: '/v1/{constructor}',
          method: 'GET',
        };

        const result = prepareRequestParams(endpoint, userIdParameters, {});

        expect(result.url).toBe('http://api.example.com/v1/{constructor}');
      });

      it('should percent-encode a percent sign in a path parameter value', () => {
        const result = prepareRequestParams(usersEndpoint, userIdParameters, {
          user_id: '%2e%2e',
        });

        expect(result.url).toBe('http://api.example.com/v1/users/%252e%252e');
        expect(new URL(result.url).pathname).toBe('/v1/users/%252e%252e');
      });
    });
  });

  describe('prepareRequestBody', () => {
    it('should format JSON body correctly', () => {
      const requestBody: OpenAPIV3.RequestBodyObject = {
        content: {
          'application/json': {
            schema: {type: 'object'},
          },
        },
      };
      const body = {foo: 'bar'};
      const bodyData = {};
      const headers = {};

      const result = prepareRequestBody(requestBody, body, bodyData, headers);

      expect(result).toBe(JSON.stringify(body));
      expect(headers).toEqual({
        'Content-Type': 'application/json',
      });
    });

    it('should fallback to JSON if no requestBody in spec', () => {
      const body = {foo: 'bar'};
      const bodyData = {};
      const headers = {};

      const result = prepareRequestBody(undefined, body, bodyData, headers);

      expect(result).toBe(JSON.stringify(body));
      expect(headers).toEqual({
        'Content-Type': 'application/json',
      });
    });

    it('should fallback to JSON and return string as is if finalData is string', () => {
      const body = 'plain text body';
      const bodyData = {};
      const headers = {};

      const result = prepareRequestBody(undefined, body, bodyData, headers);

      expect(result).toBe(body);
      expect(headers).toEqual({
        'Content-Type': 'application/json',
      });
    });

    it('should handle unsupported mime type by returning undefined', () => {
      const requestBody: OpenAPIV3.RequestBodyObject = {
        content: {
          'image/png': {
            schema: {type: 'string', format: 'binary'},
          },
        },
      };
      const body = 'fake-binary-data';
      const bodyData = {};
      const headers = {};

      const result = prepareRequestBody(requestBody, body, bodyData, headers);

      expect(result).toBeUndefined();
      expect(headers).toEqual({});
    });

    it('should handle application/json with string body correctly', () => {
      const requestBody: OpenAPIV3.RequestBodyObject = {
        content: {
          'application/json': {
            schema: {type: 'string'},
          },
        },
      };
      const body = 'string body';
      const bodyData = {};
      const headers = {};

      const result = prepareRequestBody(requestBody, body, bodyData, headers);

      expect(result).toBe(body);
      expect(headers).toEqual({
        'Content-Type': 'application/json',
      });
    });

    it('should handle text/plain body correctly', () => {
      const requestBody: OpenAPIV3.RequestBodyObject = {
        content: {
          'text/plain': {
            schema: {type: 'string'},
          },
        },
      };
      const body = 'plain text';
      const bodyData = {};
      const headers = {};

      const result = prepareRequestBody(requestBody, body, bodyData, headers);

      expect(result).toBe('plain text');
      expect(headers).toEqual({
        'Content-Type': 'text/plain',
      });
    });

    it('should fallback to JSON if requestBody has no content', () => {
      const requestBody = {} as OpenAPIV3.RequestBodyObject; // defined but no content
      const body = {foo: 'bar'};
      const bodyData = {};
      const headers = {};

      const result = prepareRequestBody(requestBody, body, bodyData, headers);

      expect(result).toBe(JSON.stringify(body));
      expect(headers).toEqual({
        'Content-Type': 'application/json',
      });
    });
  });
});

describe('RestApiTool adk-python parity', () => {
  const endpoint = {
    baseUrl: 'http://api.example.com',
    path: '/test',
    method: 'GET',
  };
  const operation: OpenAPIV3.OperationObject = {responses: {}};

  function createToolContext(): Context {
    return new Context({
      invocationContext: new InvocationContext({
        invocationId: 'invocation-1',
        agent: new LlmAgent({name: 'test_agent'}),
        session: createSession({id: 'session-1', appName: 'test_app'}),
        pluginManager: new PluginManager(),
      }),
    });
  }

  function mockOkResponse(contentType: string, bodyText: string) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => contentType},
      text: async () => bodyText,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('tool name', () => {
    it('should truncate a name longer than 60 characters', () => {
      const longName = 'a'.repeat(75);

      const tool = new RestApiTool(
        longName,
        'description',
        endpoint,
        operation,
      );

      expect(tool.name).toHaveLength(60);
      expect(tool.name).toBe('a'.repeat(60));
    });

    it('should keep a name of 60 characters', () => {
      const exactName = 'b'.repeat(60);

      const tool = new RestApiTool(
        exactName,
        'description',
        endpoint,
        operation,
      );

      expect(tool.name).toBe(exactName);
    });
  });

  describe('toString', () => {
    it('should render the name, description and endpoint', () => {
      const tool = new RestApiTool(
        'test_tool',
        'a description',
        endpoint,
        operation,
      );

      const rendered = tool.toString();

      expect(rendered).toContain('name="test_tool"');
      expect(rendered).toContain('description="a description"');
      expect(rendered).toContain('api.example.com');
    });

    it('should not render the configured credential', () => {
      const tool = new RestApiTool(
        'test_tool',
        'a description',
        endpoint,
        operation,
        undefined,
        {authType: AuthCredentialTypes.API_KEY, apiKey: 'super-secret-key'},
      );

      expect(tool.toString()).not.toContain('super-secret-key');
    });
  });

  describe('configureAuthCredential', () => {
    it('should clear the credential when it is called with nothing', async () => {
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'test-key',
      };
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpoint,
        operation,
        undefined,
        credential,
      );
      mockOkResponse('text/plain', 'ok');
      const spy = vi.spyOn(ToolAuthHandler, 'fromToolContext');

      tool.configureAuthCredential();
      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        undefined,
        expect.anything(),
      );
    });
  });

  describe('response handling', () => {
    it('should wrap a non-JSON body in a text field', async () => {
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpoint,
        operation,
      );
      mockOkResponse('text/plain', 'ok');

      const result = await tool.runAsync({
        args: {},
        toolContext: createToolContext(),
      });

      expect(result).toEqual({text: 'ok'});
    });
  });

  describe('prepareRequestParams embedded query and fragment', () => {
    const searchParam: ApiParameter = {
      name: 'key',
      originalName: 'key',
      paramLocation: 'query',
      paramSchema: {},
      required: false,
    };

    it('should let a declared parameter win over the same key in the path', () => {
      const result = prepareRequestParams(
        {baseUrl: '', path: '/api?key=embedded', method: 'GET'},
        [searchParam],
        {key: 'explicit'},
      );

      expect(result.url).toBe('/api?key=explicit');
    });

    it('should keep an embedded key alongside a declared key', () => {
      const other: ApiParameter = {
        name: 'other',
        originalName: 'other',
        paramLocation: 'query',
        paramSchema: {},
        required: false,
      };

      const result = prepareRequestParams(
        {baseUrl: '', path: '/api?embedded=1', method: 'GET'},
        [other],
        {other: '2'},
      );

      const query = new URL(result.url, 'http://api.example.com').searchParams;
      expect(query.get('other')).toBe('2');
      expect(query.get('embedded')).toBe('1');
    });

    it('should keep both embedded values of one undeclared key', () => {
      const result = prepareRequestParams(
        {baseUrl: '', path: '/api?tag=a&tag=b', method: 'GET'},
        [],
        {},
      );

      const query = new URL(result.url, 'http://api.example.com').searchParams;
      expect(query.getAll('tag')).toEqual(['a', 'b']);
    });

    it('should strip a fragment that follows a query string', () => {
      const result = prepareRequestParams(
        {baseUrl: '', path: '/api?key=embedded#section', method: 'GET'},
        [],
        {},
      );

      expect(result.url).toBe('/api?key=embedded');
    });

    it('should strip a fragment when there is no query string', () => {
      const result = prepareRequestParams(
        {baseUrl: '', path: '/api#section', method: 'GET'},
        [],
        {},
      );

      expect(result.url).toBe('/api');
    });

    it('should read no query string out of a fragment', () => {
      const result = prepareRequestParams(
        {baseUrl: '', path: '/api#section?key=fragment', method: 'GET'},
        [],
        {},
      );

      expect(result.url).toBe('/api');
    });

    it('should leave a plain path untouched', () => {
      const result = prepareRequestParams(
        {baseUrl: 'http://api.example.com', path: '/api/items', method: 'GET'},
        [],
        {},
      );

      expect(result.url).toBe('http://api.example.com/api/items');
    });
  });

  describe('prepareRequestBody content type', () => {
    it('should set the content type for a form-urlencoded body', () => {
      const requestBody: OpenAPIV3.RequestBodyObject = {
        content: {
          'application/x-www-form-urlencoded': {schema: {type: 'object'}},
        },
      };
      const headers: Record<string, string> = {};

      prepareRequestBody(requestBody, undefined, {foo: 'bar'}, headers);

      expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    });

    it('should leave the content type unset for a multipart body', () => {
      const requestBody: OpenAPIV3.RequestBodyObject = {
        content: {'multipart/form-data': {schema: {type: 'object'}}},
      };
      const headers: Record<string, string> = {};

      prepareRequestBody(requestBody, undefined, {foo: 'bar'}, headers);

      expect(headers['Content-Type']).toBeUndefined();
    });
  });

  describe('createRestApiTool', () => {
    const parsedParameters: ApiParameter[] = [
      {
        name: 'parsed_name',
        originalName: 'parsedName',
        paramLocation: 'query',
        paramSchema: {type: 'string'},
        required: false,
      },
    ];
    const operationWithOtherParams: OpenAPIV3.OperationObject = {
      responses: {},
      operationId: 'listThings',
      parameters: [
        {name: 'fromOperation', in: 'query', schema: {type: 'string'}},
      ],
    };

    it('should report the parsed parameters, not the operation ones', () => {
      const tool = createRestApiTool({
        name: 'list_things',
        description: 'description',
        endpoint,
        operation: operationWithOtherParams,
        parameters: parsedParameters,
      });

      const declaration = tool._getDeclaration();

      expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
        'parsed_name',
      ]);
    });

    it('should truncate a parsed name longer than 60 characters', () => {
      const tool = createRestApiTool({
        name: 'c'.repeat(75),
        description: 'description',
        endpoint,
        operation,
        parameters: [],
      });

      expect(tool.name).toHaveLength(60);
    });

    it('should carry the parsed credential to the auth handler', async () => {
      const authScheme: OpenAPIV3.ApiKeySecurityScheme = {
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
      };
      const authCredential: AuthCredential = {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'parsed-key',
      };
      const tool = createRestApiTool({
        name: 'test_tool',
        description: 'description',
        endpoint,
        operation,
        parameters: [],
        authScheme,
        authCredential,
      });
      mockOkResponse('text/plain', 'ok');
      const spy = vi.spyOn(ToolAuthHandler, 'fromToolContext');

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        authScheme,
        authCredential,
        expect.anything(),
      );
    });

    it('should forward the transport options to the tool', async () => {
      const headerProvider = vi
        .fn()
        .mockReturnValue({'X-Correlation-Id': 'abc'});
      const tool = createRestApiTool(
        {
          name: 'test_tool',
          description: 'description',
          endpoint,
          operation,
          parameters: [],
        },
        {headerProvider, credentialKey: 'my-key'},
      );
      mockOkResponse('text/plain', 'ok');
      const spy = vi.spyOn(ToolAuthHandler, 'fromToolContext');

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        undefined,
        {credentialKey: 'my-key'},
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({'X-Correlation-Id': 'abc'}),
        }),
      );
    });
  });

  describe('createRestApiToolFromJson', () => {
    it('should build the same tool a serialized parsed operation describes', () => {
      const parsed: ParsedOperation = {
        name: 'serialized_tool',
        description: 'a serialized description',
        endpoint,
        operation: {responses: {}, operationId: 'serializedTool'},
        parameters: [
          {
            name: 'query_arg',
            originalName: 'queryArg',
            paramLocation: 'query',
            paramSchema: {type: 'string'},
            required: true,
          },
        ],
      };

      const tool = createRestApiToolFromJson(JSON.stringify(parsed));

      expect(tool.name).toBe('serialized_tool');
      expect(tool.description).toBe('a serialized description');
      expect(
        Object.keys(tool._getDeclaration().parameters?.properties ?? {}),
      ).toEqual(['query_arg']);
    });
  });

  describe('OperationParser.load', () => {
    it('should report the parameters it is given', () => {
      const parameters: ApiParameter[] = [
        {
          name: 'seeded',
          originalName: 'seeded',
          paramLocation: 'query',
          paramSchema: {},
          required: false,
        },
      ];

      const parser = OperationParser.load(
        {
          responses: {},
          parameters: [{name: 'fromOperation', in: 'query', schema: {}}],
        },
        parameters,
      );

      expect(parser.getParameters()).toEqual(parameters);
    });
  });
});
