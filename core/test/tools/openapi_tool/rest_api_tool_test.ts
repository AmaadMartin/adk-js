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
  createSession,
  FeatureName,
  InvocationContext,
  OpenApiSpecParser,
  OperationEndpoint,
  OperationParser,
  PluginManager,
  RestApiTool,
  ToolAuthHandler,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {Type} from '@google/genai';
import {inspect} from 'node:util';
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
      parameters: {type: Type.OBJECT, properties: {}},
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

const PETS_ENDPOINT: OperationEndpoint = {
  baseUrl: 'http://api.example.com',
  path: '/pets',
  method: 'GET',
};

const PETS_OPERATION: OpenAPIV3.OperationObject = {
  operationId: 'listPets',
  parameters: [
    {
      name: 'limit',
      in: 'query',
      required: true,
      description: 'How many pets to return.',
      schema: {type: 'integer'},
    },
  ],
  responses: {},
};

const API_KEY_SCHEME: OpenAPIV3.SecuritySchemeObject = {
  type: 'apiKey',
  name: 'X-API-Key',
  in: 'header',
};

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'sk-live-secret-api-key-12345',
};

function newContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 'session-1', appName: 'app'}),
      pluginManager: new PluginManager(),
    }),
    functionCallId: 'fc-1',
  });
}

function stubFetch(response: Response) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

async function callAndReadHeaders(tool: RestApiTool): Promise<Headers> {
  const fetchSpy = stubFetch(jsonResponse({result: 'ok'}));
  await tool.runAsync({args: {}, toolContext: newContext()});
  const init = fetchSpy.mock.calls[0][1];
  return new Headers(init?.headers);
}

describe('RestApiTool declaration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should convert the schema to a Gemini schema when the flag is off', () => {
    const tool = new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      PETS_OPERATION,
    );

    const declaration = tool._getDeclaration();

    expect(declaration.parametersJsonSchema).toBeUndefined();
    expect(declaration.parameters?.type).toBe(Type.OBJECT);
    expect(declaration.parameters?.properties?.['limit']?.type).toBe(
      Type.INTEGER,
    );
    expect(declaration.parameters?.required).toEqual(['limit']);
  });

  it('should pass the raw JSON schema through when the flag is on', async () => {
    const tool = new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      PETS_OPERATION,
    );

    const declaration = await withTemporaryFeatureOverride(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
      true,
      () => tool._getDeclaration(),
    );

    expect(declaration.parameters).toBeUndefined();
    expect(declaration.parametersJsonSchema).toEqual({
      type: 'object',
      properties: {limit: {type: 'integer'}},
      required: ['limit'],
      title: 'listPets_Arguments',
    });
  });

  it('should read the flag on every call, not once in the constructor', async () => {
    const tool = new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      PETS_OPERATION,
    );

    const withFlagOff = tool._getDeclaration();
    const withFlagOn = await withTemporaryFeatureOverride(
      FeatureName.JSON_SCHEMA_FOR_FUNC_DECL,
      true,
      () => tool._getDeclaration(),
    );

    expect(withFlagOff.parametersJsonSchema).toBeUndefined();
    expect(withFlagOff.parameters).toBeDefined();
    expect(withFlagOn.parametersJsonSchema).toBeDefined();
    expect(withFlagOn.parameters).toBeUndefined();
  });
});

describe('RestApiTool construction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should keep a typed endpoint, operation and scheme observable', () => {
    const tool = new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      PETS_OPERATION,
      API_KEY_SCHEME,
      API_KEY_CREDENTIAL,
    );

    expect(tool.toString()).toContain(JSON.stringify(PETS_ENDPOINT));
    expect(inspect(tool)).toContain(JSON.stringify(PETS_OPERATION));
    expect(inspect(tool)).toContain(JSON.stringify(API_KEY_SCHEME));
  });

  it('should accept the JSON string form of every argument', () => {
    const fromObjects = new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      PETS_OPERATION,
      API_KEY_SCHEME,
      API_KEY_CREDENTIAL,
    );
    const fromStrings = new RestApiTool(
      'list_pets',
      'List pets.',
      JSON.stringify(PETS_ENDPOINT),
      JSON.stringify(PETS_OPERATION),
      JSON.stringify(API_KEY_SCHEME),
      JSON.stringify(API_KEY_CREDENTIAL),
    );

    expect(fromStrings._getDeclaration()).toEqual(
      fromObjects._getDeclaration(),
    );
    expect(fromStrings.toString()).toBe(fromObjects.toString());
    expect(inspect(fromStrings)).toBe(inspect(fromObjects));
  });

  it('should send the credential the JSON string form carries', async () => {
    const tool = new RestApiTool(
      'list_pets',
      'List pets.',
      JSON.stringify(PETS_ENDPOINT),
      JSON.stringify(PETS_OPERATION),
      JSON.stringify(API_KEY_SCHEME),
      JSON.stringify(API_KEY_CREDENTIAL),
    );

    const headers = await callAndReadHeaders(tool);

    expect(headers.get('X-API-Key')).toBe(API_KEY_CREDENTIAL.apiKey);
  });

  it('should reject an endpoint string that is not JSON', () => {
    expect(
      () =>
        new RestApiTool('list_pets', 'List pets.', 'not json', PETS_OPERATION),
    ).toThrow(/Invalid endpoint:/);
  });

  it('should reject an endpoint string that is not an object', () => {
    expect(
      () => new RestApiTool('list_pets', 'List pets.', '[]', PETS_OPERATION),
    ).toThrow('Invalid endpoint: expected a JSON object.');
  });

  it('should reject an endpoint string with no method', () => {
    const endpoint = JSON.stringify({
      baseUrl: 'http://api.example.com',
      path: '/pets',
    });

    expect(
      () =>
        new RestApiTool('list_pets', 'List pets.', endpoint, PETS_OPERATION),
    ).toThrow("Invalid endpoint: 'method' must be a string.");
  });

  it('should reject an operation string that parses to an array', () => {
    expect(
      () => new RestApiTool('list_pets', 'List pets.', PETS_ENDPOINT, '[]'),
    ).toThrow('Invalid operation: expected a JSON object.');
  });

  it('should reject an operation string with no responses', () => {
    expect(
      () =>
        new RestApiTool(
          'list_pets',
          'List pets.',
          PETS_ENDPOINT,
          JSON.stringify({operationId: 'listPets'}),
        ),
    ).toThrow("Invalid operation: 'responses' must be an object.");
  });

  it('should reject a credential string with an unknown authType', () => {
    expect(
      () =>
        new RestApiTool(
          'list_pets',
          'List pets.',
          PETS_ENDPOINT,
          PETS_OPERATION,
          API_KEY_SCHEME,
          JSON.stringify({authType: 'telepathy'}),
        ),
    ).toThrow('Invalid auth credential: unknown authType telepathy.');
  });

  it('should reject a credential string with no authType', () => {
    expect(
      () =>
        new RestApiTool(
          'list_pets',
          'List pets.',
          PETS_ENDPOINT,
          PETS_OPERATION,
          API_KEY_SCHEME,
          '{}',
        ),
    ).toThrow("Invalid auth credential: 'authType' is missing.");
  });

  it('should reject a credential string that is not JSON', () => {
    expect(
      () =>
        new RestApiTool(
          'list_pets',
          'List pets.',
          PETS_ENDPOINT,
          PETS_OPERATION,
          API_KEY_SCHEME,
          'not json',
        ),
    ).toThrow(/Invalid auth credential:/);
  });
});

describe('RestApiTool shouldParseOperation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function countingOperation(counter: {reads: number}) {
    const operation: OpenAPIV3.OperationObject = {
      operationId: 'listPets',
      responses: {},
      get parameters() {
        counter.reads++;
        return [];
      },
    };
    return operation;
  }

  it('should parse the operation by default', () => {
    const counter = {reads: 0};

    new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      countingOperation(counter),
    );

    expect(counter.reads).toBe(1);
  });

  it('should not parse the operation when asked not to', () => {
    const counter = {reads: 0};

    new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      countingOperation(counter),
      undefined,
      undefined,
      {shouldParseOperation: false},
    );

    expect(counter.reads).toBe(0);
  });

  it('should tell the caller to install a parser before declaring', () => {
    const tool = new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      PETS_OPERATION,
      undefined,
      undefined,
      {shouldParseOperation: false},
    );

    expect(() => tool._getDeclaration()).toThrow(/setOperationParser\(\)/);
  });

  it('should tell the caller to install a parser before running', async () => {
    const tool = new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      PETS_OPERATION,
      undefined,
      undefined,
      {shouldParseOperation: false},
    );

    await expect(
      tool.runAsync({args: {}, toolContext: newContext()}),
    ).rejects.toThrow(/setOperationParser\(\)/);
  });

  it('should declare once the caller installs a parser', () => {
    const tool = new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      PETS_OPERATION,
      undefined,
      undefined,
      {shouldParseOperation: false},
    );

    tool.setOperationParser(new OperationParser(PETS_OPERATION));

    expect(
      tool._getDeclaration().parameters?.properties?.['limit'],
    ).toBeDefined();
  });
});

describe('RestApiTool auth configuration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function newTool(): RestApiTool {
    return new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      PETS_OPERATION,
    );
  }

  it('should coerce an untyped scheme into one that sends its header', async () => {
    const tool = newTool();
    tool.configureAuthScheme({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    });
    tool.configureAuthCredential(API_KEY_CREDENTIAL);

    const headers = await callAndReadHeaders(tool);

    expect(headers.get('X-API-Key')).toBe(API_KEY_CREDENTIAL.apiKey);
  });

  it('should accept the JSON string form of a scheme', async () => {
    const tool = newTool();
    tool.configureAuthScheme(JSON.stringify(API_KEY_SCHEME));
    tool.configureAuthCredential(API_KEY_CREDENTIAL);

    const headers = await callAndReadHeaders(tool);

    expect(headers.get('X-API-Key')).toBe(API_KEY_CREDENTIAL.apiKey);
  });

  it('should reject a scheme string that is not JSON', () => {
    expect(() => newTool().configureAuthScheme('not json')).toThrow(
      /Invalid security scheme:/,
    );
  });

  it('should reject a scheme that names no type', () => {
    expect(() => newTool().configureAuthScheme({in: 'header'})).toThrow(
      "Missing 'type' field in security scheme dictionary.",
    );
  });

  it('should reject a scheme with an unknown type', () => {
    expect(() => newTool().configureAuthScheme({type: 'nope'})).toThrow(
      'Invalid security scheme type: nope',
    );
  });

  it('should reject an apiKey scheme sited in the body', () => {
    expect(() =>
      newTool().configureAuthScheme({
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'body',
      }),
    ).toThrow("Invalid security scheme data: 'in' must be one of");
  });

  it('should reject an oauth2 scheme with no flows', () => {
    expect(() => newTool().configureAuthScheme({type: 'oauth2'})).toThrow(
      "Invalid security scheme data: 'flows' must be an object.",
    );
  });

  it('should send the same header for a credential given as JSON text', async () => {
    const fromObject = newTool();
    fromObject.configureAuthScheme(API_KEY_SCHEME);
    fromObject.configureAuthCredential(API_KEY_CREDENTIAL);

    const fromString = newTool();
    fromString.configureAuthScheme(API_KEY_SCHEME);
    fromString.configureAuthCredential(JSON.stringify(API_KEY_CREDENTIAL));

    expect(headerRecord(await callAndReadHeaders(fromString))).toEqual(
      headerRecord(await callAndReadHeaders(fromObject)),
    );
  });

  it('should clear the credential when given nothing', async () => {
    const tool = newTool();
    tool.configureAuthScheme(API_KEY_SCHEME);
    tool.configureAuthCredential(API_KEY_CREDENTIAL);
    tool.configureAuthCredential();

    const fetchSpy = stubFetch(jsonResponse({result: 'ok'}));
    const result = await tool.runAsync({
      args: {},
      toolContext: newContext(),
    });

    expect(result).toEqual({
      pending: true,
      message: 'Needs your authorization to access your data.',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('RestApiTool rendering', () => {
  function newTool(): RestApiTool {
    return new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      PETS_OPERATION,
      API_KEY_SCHEME,
      API_KEY_CREDENTIAL,
    );
  }

  it('should render the name, description and endpoint', () => {
    const rendered = newTool().toString();

    expect(rendered).toContain('name="list_pets"');
    expect(rendered).toContain('description="List pets."');
    expect(rendered).toContain('endpoint="');
    expect(rendered).not.toContain('operation="');
    expect(rendered).not.toContain('authScheme="');
  });

  it('should additionally render the operation and scheme when inspected', () => {
    const rendered = inspect(newTool());

    expect(rendered).toContain('name="list_pets"');
    expect(rendered).toContain('endpoint="');
    expect(rendered).toContain('operation="');
    expect(rendered).toContain('authScheme="');
  });

  it('should never render the credential', () => {
    const tool = newTool();

    for (const rendered of [tool.toString(), inspect(tool)]) {
      expect(rendered).not.toContain('sk-live-secret-api-key-12345');
      expect(rendered).not.toContain('authCredential');
    }
  });
});

describe('RestApiTool detectErrorInResponse', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function newTool(): RestApiTool {
    return new RestApiTool(
      'list_pets',
      'List pets.',
      PETS_ENDPOINT,
      PETS_OPERATION,
    );
  }

  it('should classify a response carrying a truthy error', () => {
    expect(newTool().detectErrorInResponse({error: 'boom'})).toBe('HTTP_ERROR');
  });

  it.each([
    ['an empty error', {error: ''}],
    ['a null error', {error: null}],
    ['no error key', {result: 'ok'}],
    ['an empty array', []],
    ['an array of strings', ['error']],
    ['a string', 'error'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 0],
  ])('should not classify %s', (_name, response) => {
    expect(newTool().detectErrorInResponse(response)).toBeUndefined();
  });

  it('should classify what runAsync returns for a failed request', async () => {
    const tool = newTool();
    stubFetch(jsonResponse({error: 'Status Code: 500'}, 500));

    const response = await tool.runAsync({
      args: {},
      toolContext: newContext(),
    });

    expect(tool.detectErrorInResponse(response)).toBe('HTTP_ERROR');
  });

  it('should classify what runAsync returns for a transport failure', async () => {
    const tool = newTool();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('connect ECONNREFUSED'),
    );

    const response = await tool.runAsync({
      args: {},
      toolContext: newContext(),
    });

    expect(tool.detectErrorInResponse(response)).toBe('HTTP_ERROR');
  });

  it('should not classify what runAsync returns for a successful request', async () => {
    const tool = newTool();
    stubFetch(jsonResponse({result: 'ok'}));

    const response = await tool.runAsync({
      args: {},
      toolContext: newContext(),
    });

    expect(tool.detectErrorInResponse(response)).toBeUndefined();
  });
});
