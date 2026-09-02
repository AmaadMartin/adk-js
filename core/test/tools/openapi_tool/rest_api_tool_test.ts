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
  credentialToParam,
  FeatureName,
  FetchFn,
  INTERNAL_AUTH_PREFIX,
  InvocationContext,
  LlmAgent,
  OpenApiSpecParser,
  OpenAPIToolset,
  OperationEndpoint,
  OperationParser,
  overrideFeatureEnabled,
  ParsedOperation,
  PluginManager,
  RestApiTool,
  tokenToSchemeCredential,
  ToolAuthHandler,
  version,
  withTemporaryFeatureOverride,
} from '@google/adk';
import {Type} from '@google/genai';
import {inspect} from 'node:util';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createApiKeyScheme} from '../../../src/tools/openapi_tool/auth/auth_helpers.js';
import {
  prepareRequestBody,
  prepareRequestParams,
} from '../../../src/tools/openapi_tool/rest_api_tool.js';

function createToolContext(state: Record<string, unknown> = {}): Context {
  return new Context({
    invocationContext: {
      session: {state},
      agent: {name: 'test-agent'},
    } as unknown as InvocationContext,
    functionCallId: 'call-1',
  });
}

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

  it('should send a header set by setDefaultHeaders', async () => {
    const tool = new RestApiTool(
      'test_tool',
      'description',
      {baseUrl: 'http://api.example.com', path: '/test', method: 'GET'},
      {responses: {}},
    );
    tool.setDefaultHeaders({'developer-token': 'default-value'});

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    await tool.runAsync({args: {}, toolContext: createToolContext()});

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({
          'developer-token': 'default-value',
        }),
      }),
    );
  });

  it('should keep a request header over a default header of the same name', async () => {
    const operation: OpenAPIV3.OperationObject = {
      responses: {},
      parameters: [
        {name: 'developer-token', in: 'header', schema: {type: 'string'}},
      ],
    };
    const tool = new RestApiTool(
      'test_tool',
      'description',
      {baseUrl: 'http://api.example.com', path: '/test', method: 'GET'},
      operation,
    );
    tool.setDefaultHeaders({'developer-token': 'default-value'});

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    // The tool-facing argument name is the snake_case form of the header
    // name. The header that leaves the process keeps the name the spec gives.
    await tool.runAsync({
      args: {developer_token: 'request-value'},
      toolContext: createToolContext(),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({
          'developer-token': 'request-value',
        }),
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

  it('authenticates a second call from the credential the first call stored', async () => {
    const tool = new RestApiTool(
      'test_tool',
      'description',
      {baseUrl: 'http://api.example.com', path: '/test', method: 'GET'},
      {responses: {}},
      createApiKeyScheme('X-API-Key', 'header'),
    );
    tool.configureCredentialKey('rest_tool_key');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });

    // The client answered the credential request, so the auth response is
    // waiting in the temp slot of this invocation.
    const first = createToolContext({
      'temp:rest_tool_key': {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret-key',
      },
    });
    await tool.runAsync({args: {}, toolContext: first});

    // The next invocation starts from the persisted state. Temp state does
    // not survive it, so the tool can only authenticate from the store.
    const persisted = first.state.toRecord();
    delete persisted['temp:rest_tool_key'];
    const second = createToolContext(persisted);
    const getAuthResponse = vi.spyOn(second, 'getAuthResponse');
    await tool.runAsync({args: {}, toolContext: second});

    expect(getAuthResponse).not.toHaveBeenCalled();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(globalThis.fetch).mock.calls) {
      expect(call[1]?.headers).toMatchObject({'X-API-Key': 'secret-key'});
    }
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

  it('should report the argument schema of its operation', () => {
    const tool = new RestApiTool(
      'test_tool',
      'description',
      {baseUrl: 'http://api.example.com', path: '/test', method: 'GET'},
      {
        operationId: 'test_tool',
        parameters: [
          {
            name: 'userId',
            in: 'query',
            required: true,
            schema: {type: 'string'},
          },
        ],
        responses: {},
      },
    );

    expect(tool.getJsonSchema()).toEqual({
      type: 'object',
      properties: {user_id: {type: 'string'}},
      required: ['user_id'],
      title: 'test_tool_Arguments',
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
      text: async () => JSON.stringify(jsonResponse),
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
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'test-key',
    };

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

    it('drops a fragment the spec put on the path', () => {
      // The generated Application Integration connector spec appends
      // `#<operation>_<entity>` so that two operations on one path stay
      // distinct. An HTTP request carries no fragment.
      const endpoint = {
        baseUrl: 'http://api.example.com',
        path: '/v2/integrations/Execute:execute?triggerId=t#list_Issues',
        method: 'POST',
      };

      const result = prepareRequestParams(endpoint, [], {});

      expect(result.url).toBe(
        'http://api.example.com/v2/integrations/Execute:execute?triggerId=t',
      );
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
        const auth = credentialToParam(createApiKeyScheme('key', 'query'), {
          authType: AuthCredentialTypes.API_KEY,
          apiKey: 'test-api-key',
        });
        if (!auth) {
          expect.fail('credentialToParam returned no parameter');
        }

        const result = prepareRequestParams(
          usersEndpoint,
          [...userIdParameters, auth.param],
          {user_id: '../../admin/export', ...auth.kwargs},
        );

        expect(new URL(result.url).pathname).toBe(
          '/v1/users/..%2F..%2Fadmin%2Fexport',
        );
        expect(new URL(result.url).searchParams.get('key')).toBe(
          'test-api-key',
        );
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

    const complete = {
      name: 'serialized_tool',
      description: 'a serialized description',
      endpoint,
      operation: {responses: {}},
      parameters: [],
    };
    const incomplete: Array<[string, Record<string, unknown>]> = [
      ['no name', {...complete, name: undefined}],
      ['no parameters', {...complete, parameters: undefined}],
      [
        'a parameters value that is not an array',
        {...complete, parameters: {}},
      ],
      ['no endpoint', {...complete, endpoint: undefined}],
      ['no operation', {...complete, operation: undefined}],
    ];

    it.each(incomplete)('should reject a document with %s', (_case, value) => {
      expect(() => createRestApiToolFromJson(JSON.stringify(value))).toThrow(
        'A serialized ParsedOperation needs a name, an endpoint, an ' +
          'operation and a parameters array.',
      );
    });
  });

  describe('OperationParser', () => {
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

      const parser = new OperationParser(
        {
          responses: {},
          parameters: [{name: 'fromOperation', in: 'query', schema: {}}],
        },
        {parameters},
      );

      expect(parser.getParameters()).toEqual(parameters);
    });
  });
});

describe('RestApiTool request and response parity', () => {
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

  /** Records the request a tool issues and answers it. */
  function recordingFetch(
    response: {status?: number; contentType?: string; body?: string} = {},
  ) {
    const calls: Array<{url: string; headers: Headers}> = [];
    const fetchFn: FetchFn = vi.fn(async (input, init) => {
      calls.push({url: String(input), headers: new Headers(init?.headers)});
      return new Response(response.body ?? 'ok', {
        status: response.status ?? 200,
        headers: {'content-type': response.contentType ?? 'text/plain'},
      });
    });
    return {calls, fetchFn};
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('headers', () => {
    it('should send the ADK user agent', async () => {
      const {calls, fetchFn} = recordingFetch();
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpoint,
        operation,
        undefined,
        undefined,
        {fetchFn},
      );

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(calls[0].headers.get('user-agent')).toBe(
        `google-adk/${version} (tool: test_tool)`,
      );
    });

    it('should let a header parameter override the user agent', async () => {
      const {calls, fetchFn} = recordingFetch();
      const parameters: ApiParameter[] = [
        {
          name: 'user_agent',
          originalName: 'User-Agent',
          paramLocation: 'header',
          paramSchema: {type: 'string'},
          required: false,
        },
      ];
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpoint,
        operation,
        undefined,
        undefined,
        {fetchFn, parameters},
      );

      await tool.runAsync({
        args: {user_agent: 'custom-agent'},
        toolContext: createToolContext(),
      });

      expect(calls[0].headers.get('user-agent')).toBe('custom-agent');
    });

    it('should not let a default header override the user agent', async () => {
      const {calls, fetchFn} = recordingFetch();
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpoint,
        operation,
        undefined,
        undefined,
        {fetchFn},
      );
      tool.setDefaultHeaders({'user-agent': 'default-agent'});

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(calls[0].headers.get('user-agent')).toBe(
        `google-adk/${version} (tool: test_tool)`,
      );
    });

    it('should send a default header the request does not carry', async () => {
      const {calls, fetchFn} = recordingFetch();
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpoint,
        operation,
        undefined,
        undefined,
        {fetchFn},
      );
      tool.setDefaultHeaders({'X-Tenant': 'acme'});

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(calls[0].headers.get('x-tenant')).toBe('acme');
    });

    it('should not let a default header override the body content type', async () => {
      const {calls, fetchFn} = recordingFetch();
      const postOperation: OpenAPIV3.OperationObject = {
        responses: {},
        requestBody: {
          content: {'application/json': {schema: {type: 'object'}}},
        },
      };
      const parameters: ApiParameter[] = [
        {
          name: 'body',
          originalName: 'body',
          paramLocation: 'body',
          paramSchema: {type: 'object'},
          required: true,
        },
      ];
      const tool = new RestApiTool(
        'test_tool',
        'description',
        {...endpoint, method: 'POST'},
        postOperation,
        undefined,
        undefined,
        {fetchFn, parameters},
      );
      tool.setDefaultHeaders({'Content-Type': 'text/plain'});

      await tool.runAsync({
        args: {body: {foo: 'bar'}},
        toolContext: createToolContext(),
      });

      expect(calls[0].headers.get('content-type')).toBe('application/json');
    });

    it('should send the additional headers of an HTTP credential', async () => {
      const {calls, fetchFn} = recordingFetch();
      const credential: AuthCredential = {
        authType: AuthCredentialTypes.HTTP,
        http: {
          scheme: 'bearer',
          credentials: {token: 'token'},
          additionalHeaders: {'X-Goog-User-Project': 'a-project'},
        },
      };
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpoint,
        operation,
        undefined,
        credential,
        {fetchFn},
      );

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(calls[0].headers.get('x-goog-user-project')).toBe('a-project');
    });
  });

  describe('query parameters', () => {
    const queryParameters: ApiParameter[] = [
      'flag',
      'offset',
      'cursor',
      'missing',
      'empty',
    ].map((name) => ({
      name,
      originalName: name,
      paramLocation: 'query',
      paramSchema: {},
      required: false,
    }));

    it('should drop a null or undefined value and keep a falsy one', () => {
      const result = prepareRequestParams(endpoint, queryParameters, {
        flag: false,
        offset: 0,
        cursor: null,
        missing: undefined,
        empty: '',
      });

      expect(result.url).toBe(
        'http://api.example.com/test?flag=false&offset=0&empty=',
      );
    });
  });

  describe('cookie parameters', () => {
    it('should send the cookie parameters in one Cookie header', () => {
      const parameters: ApiParameter[] = ['sid', 'theme'].map((name) => ({
        name,
        originalName: name,
        paramLocation: 'cookie',
        paramSchema: {},
        required: false,
      }));

      const result = prepareRequestParams(endpoint, parameters, {
        sid: 'abc',
        theme: 'dark',
      });

      expect(result.headers).toEqual({Cookie: 'sid=abc; theme=dark'});
      expect(result.url).toBe('http://api.example.com/test');
    });
  });

  describe('base URL', () => {
    it('should remove one trailing slash from the base URL', () => {
      const result = prepareRequestParams(
        {baseUrl: 'http://api.example.com/', path: '/trailing', method: 'GET'},
        [],
        {},
      );

      expect(result.url).toBe('http://api.example.com/trailing');
    });

    it('should remove only one trailing slash', () => {
      const result = prepareRequestParams(
        {baseUrl: 'http://api.example.com//', path: '/trailing', method: 'GET'},
        [],
        {},
      );

      expect(result.url).toBe('http://api.example.com//trailing');
    });

    it('should return the path alone for an empty base URL', () => {
      const result = prepareRequestParams(
        {baseUrl: '', path: '/no_base', method: 'GET'},
        [],
        {},
      );

      expect(result.url).toBe('/no_base');
    });
  });

  describe('octet-stream body', () => {
    it('should send the raw value and set the content type', () => {
      const requestBody: OpenAPIV3.RequestBodyObject = {
        content: {'application/octet-stream': {schema: {type: 'string'}}},
      };
      const headers: Record<string, string> = {};
      const raw = new Uint8Array([1, 2, 3]);

      const result = prepareRequestBody(requestBody, raw, {}, headers);

      expect(result).toBe(raw);
      expect(headers['Content-Type']).toBe('application/octet-stream');
    });
  });

  describe('schema defaults', () => {
    const defaultedOperation: OpenAPIV3.OperationObject = {responses: {}};
    const parameters: ApiParameter[] = [
      {
        name: 'user_id',
        originalName: 'userId',
        paramLocation: 'path',
        paramSchema: {type: 'string', default: 'me'},
        required: true,
      },
    ];

    function createDefaultingTool(fetchFn: FetchFn) {
      return new RestApiTool(
        'test_tool',
        'description',
        {
          baseUrl: 'http://api.example.com',
          path: '/users/{userId}/messages',
          method: 'GET',
        },
        defaultedOperation,
        undefined,
        undefined,
        {fetchFn, parameters},
      );
    }

    it('should fill in the default of an omitted required parameter', async () => {
      const {calls, fetchFn} = recordingFetch();

      await createDefaultingTool(fetchFn).runAsync({
        args: {},
        toolContext: createToolContext(),
      });

      expect(calls[0].url).toBe('http://api.example.com/users/me/messages');
    });

    it('should not override a value the model supplied', async () => {
      const {calls, fetchFn} = recordingFetch();

      await createDefaultingTool(fetchFn).runAsync({
        args: {user_id: 'u-1'},
        toolContext: createToolContext(),
      });

      expect(calls[0].url).toBe('http://api.example.com/users/u-1/messages');
    });
  });

  describe('response status', () => {
    it('should return the retry-advising error object for a non-2xx', async () => {
      const {fetchFn} = recordingFetch({
        status: 500,
        body: 'Internal Server Error',
      });
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpoint,
        operation,
        undefined,
        undefined,
        {fetchFn},
      );

      const result = await tool.runAsync({
        args: {},
        toolContext: createToolContext(),
      });

      expect(result).toEqual({
        error:
          'Tool test_tool execution failed. Analyze this execution error and ' +
          'your inputs. Retry with adjustments if applicable. But make sure ' +
          "don't retry more than 3 times. Execution Error: Status Code: 500, " +
          'Internal Server Error',
      });
    });

    it('should not return the parsed body of a JSON error response', async () => {
      const {fetchFn} = recordingFetch({
        status: 404,
        contentType: 'application/json',
        body: '{"message":"not found"}',
      });
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpoint,
        operation,
        undefined,
        undefined,
        {fetchFn},
      );

      const result = await tool.runAsync({
        args: {},
        toolContext: createToolContext(),
      });

      expect(result).toEqual({
        error: expect.stringContaining(
          'Status Code: 404, {"message":"not found"}',
        ),
      });
    });
  });

  describe('fetchFn', () => {
    it('should use the supplied fetch instead of the global one', async () => {
      const {calls, fetchFn} = recordingFetch();
      globalThis.fetch = vi.fn();
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpoint,
        operation,
        undefined,
        undefined,
        {fetchFn},
      );

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(calls).toHaveLength(1);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('should use the global fetch when none is supplied', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: {get: () => 'text/plain'},
        text: async () => 'ok',
      });
      const tool = new RestApiTool(
        'test_tool',
        'description',
        endpoint,
        operation,
      );

      await tool.runAsync({args: {}, toolContext: createToolContext()});

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });
});

const ENDPOINT: OperationEndpoint = {
  baseUrl: 'http://api.example.com',
  path: '/test',
  method: 'GET',
};

const OPERATION: OpenAPIV3.OperationObject = {responses: {}};

const QUERY_OPERATION: OpenAPIV3.OperationObject = {
  operationId: 'test_op',
  parameters: [
    {name: 'q', in: 'query', required: true, schema: {type: 'string'}},
  ],
  responses: {},
};

/** Stubs `fetch` with a response whose body is `body`. */
function stubFetch(body: string, contentType = 'application/json'): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    headers: {get: () => contentType},
    text: async () => body,
  });
}

function newContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'invocation-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'session-1', appName: 'test_app'}),
      pluginManager: new PluginManager(),
    }),
    functionCallId: 'function-call-1',
  });
}

describe('RestApiTool declaration', () => {
  afterEach(() => {
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, undefined);
  });

  it('should convert the schema to a Gemini schema when the flag is off', () => {
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, false);
    const tool = new RestApiTool(
      'test_tool',
      'description',
      ENDPOINT,
      QUERY_OPERATION,
    );

    const declaration = tool._getDeclaration();

    expect(declaration.parametersJsonSchema).toBeUndefined();
    expect(declaration.parameters).toEqual({
      type: Type.OBJECT,
      properties: {q: {type: Type.STRING}},
      required: ['q'],
    });
  });

  it('should pass the raw schema through when the flag is on', () => {
    overrideFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL, true);
    const tool = new RestApiTool(
      'test_tool',
      'description',
      ENDPOINT,
      QUERY_OPERATION,
    );

    const declaration = tool._getDeclaration();

    expect(declaration.parameters).toBeUndefined();
    expect(declaration.parametersJsonSchema).toEqual(
      new OperationParser(QUERY_OPERATION).getJsonSchema(),
    );
  });
});

describe('RestApiTool response parsing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [
      'a JSON body served as text/plain',
      '{"ok":true}',
      'text/plain',
      {ok: true},
    ],
    [
      'a JSON body served as application/json',
      '{"ok":true}',
      'application/json',
      {ok: true},
    ],
    [
      'a body that is not JSON',
      'plain text',
      'text/plain',
      {text: 'plain text'},
    ],
    ['an empty body', '', 'application/json', {text: ''}],
    ['a JSON string body', '"hi"', 'application/json', 'hi'],
    ['a JSON number body', '42', 'application/json', 42],
  ])('should return %s', async (_label, body, contentType, expected) => {
    const tool = new RestApiTool(
      'test_tool',
      'description',
      ENDPOINT,
      OPERATION,
    );
    stubFetch(body, contentType);

    const result = await tool.runAsync({
      args: {},
      toolContext: newContext(),
    });

    expect(result).toEqual(expected);
  });

  it('should report a transport failure rather than a parse failure', async () => {
    const tool = new RestApiTool(
      'test_tool',
      'description',
      ENDPOINT,
      OPERATION,
    );
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));

    const result = await tool.runAsync({
      args: {},
      toolContext: newContext(),
    });

    expect(result).toEqual({
      error: 'Failed to execute API call: network down',
    });
  });
});

describe('RestApiTool auth scheme validation', () => {
  it('should reject a scheme a specification declares without its name', () => {
    const spec = {
      openapi: '3.0.0',
      info: {title: 'test', version: '1.0.0'},
      servers: [{url: 'http://api.example.com'}],
      paths: {
        '/test': {
          get: {
            operationId: 'get_test',
            security: [{apiKey: []}],
            responses: {},
          },
        },
      },
      components: {
        securitySchemes: {apiKey: {type: 'apiKey', in: 'header'}},
      },
    };

    expect(() => new OpenAPIToolset({specStr: JSON.stringify(spec)})).toThrow(
      "Invalid security scheme data: 'name' must be a string.",
    );
  });

  it('should reject a scheme the setter reads from configuration', () => {
    const tool = new RestApiTool(
      'test_tool',
      'description',
      ENDPOINT,
      OPERATION,
    );
    const scheme: OpenAPIV3.SecuritySchemeObject =
      JSON.parse('{"type":"http"}');

    expect(() => tool.configureAuthScheme(scheme)).toThrow(
      "Invalid security scheme data: 'scheme' must be a string.",
    );
  });
});

describe('RestApiTool credential routing', () => {
  const endpoint = {
    baseUrl: 'http://api.example.com',
    path: '/test',
    method: 'GET',
  };
  const operation: OpenAPIV3.OperationObject = {responses: {}};

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });
    globalThis.fetch = fetchMock;
    return fetchMock;
  }

  function stubResolvedCredential(authCredential?: AuthCredential): void {
    vi.spyOn(
      ToolAuthHandler.prototype,
      'prepareAuthCredentials',
    ).mockResolvedValue({state: 'done', authCredential});
  }

  function createToolContext(): Context {
    return new Context({
      invocationContext: new InvocationContext({
        invocationId: 'inv-1',
        session: createSession({id: 'session-1', appName: 'app'}),
        pluginManager: new PluginManager(),
      }),
    });
  }

  // Every request also carries the ADK user agent, so each expectation below
  // names it alongside the headers the credential itself contributes.
  const userAgent = {'User-Agent': `google-adk/${version} (tool: test_tool)`};

  function run(authScheme?: OpenAPIV3.SecuritySchemeObject): Promise<unknown> {
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
      authScheme,
    );
    return tool.runAsync({args: {}, toolContext: createToolContext()});
  }

  it('sends an api key declared in a cookie as a Cookie header', async () => {
    const fetchMock = stubFetch();
    stubResolvedCredential({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret_key',
    });

    await run({type: 'apiKey', name: 'session_id', in: 'cookie'});

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.example.com/test',
      expect.objectContaining({
        headers: {Cookie: 'session_id=secret_key', ...userAgent},
      }),
    );
  });

  it('sends an api key declared in the query string on the url', async () => {
    const fetchMock = stubFetch();
    stubResolvedCredential({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret_key',
    });

    await run({type: 'apiKey', name: 'key', in: 'query'});

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.example.com/test?key=secret_key',
      expect.objectContaining({headers: {...userAgent}}),
    );
  });

  it('sends an exchanged bearer token as an Authorization header', async () => {
    const fetchMock = stubFetch();
    stubResolvedCredential({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'test_token'}},
    });

    await run({type: 'http', scheme: 'bearer'});

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.example.com/test',
      expect.objectContaining({
        headers: {Authorization: 'Bearer test_token', ...userAgent},
      }),
    );
  });

  it('sends the additional headers of an exchanged credential', async () => {
    const fetchMock = stubFetch();
    stubResolvedCredential({
      authType: AuthCredentialTypes.HTTP,
      http: {
        scheme: 'bearer',
        credentials: {token: 'my_token'},
        additionalHeaders: {'x-goog-user-project': 'quota_project'},
      },
    });

    await run({type: 'http', scheme: 'bearer'});

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.example.com/test',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer my_token',
          'x-goog-user-project': 'quota_project',
          ...userAgent,
        },
      }),
    );
  });

  it('rejects basic credentials instead of sending an unauthenticated request', async () => {
    const fetchMock = stubFetch();
    stubResolvedCredential({
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'basic', credentials: {username: 'u', password: 'p'}},
    });

    await expect(run({type: 'http', scheme: 'basic'})).rejects.toThrow(
      'Basic Authentication is not supported.',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends no credential when the tool declares no auth scheme', async () => {
    const fetchMock = stubFetch();
    stubResolvedCredential({
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'secret_key',
    });

    await run(undefined);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.example.com/test',
      expect.objectContaining({headers: {...userAgent}}),
    );
  });

  it('exposes the auth helpers on the package entry point', () => {
    expect(INTERNAL_AUTH_PREFIX).toBe('_auth_prefix_vaf_');

    const {param, kwargs} =
      credentialToParam(
        {type: 'apiKey', name: 'X-API-Key', in: 'header'},
        tokenToSchemeCredential('apikey', 'header', 'X-API-Key', 'k')
          .authCredential,
      ) ?? {};

    expect(param?.name).toBe(`${INTERNAL_AUTH_PREFIX}X-API-Key`);
    expect(kwargs).toEqual({[`${INTERNAL_AUTH_PREFIX}X-API-Key`]: 'k'});
  });
});

describe('prepareRequestParams cookie parameters', () => {
  const endpoint = {
    baseUrl: 'http://api.example.com',
    path: '/test',
    method: 'GET',
  };

  it('joins several cookie parameters into one Cookie header', () => {
    const parameters: ApiParameter[] = [
      {
        name: 'session_id',
        originalName: 'session_id',
        paramLocation: 'cookie',
        paramSchema: {},
        required: false,
      },
      {
        name: 'tenant',
        originalName: 'tenant',
        paramLocation: 'cookie',
        paramSchema: {},
        required: false,
      },
    ];

    const result = prepareRequestParams(endpoint, parameters, {
      session_id: 'abc',
      tenant: 'acme',
    });

    expect(result.headers).toEqual({Cookie: 'session_id=abc; tenant=acme'});
  });

  it('sets no Cookie header when no cookie parameter is supplied', () => {
    const parameters: ApiParameter[] = [
      {
        name: 'session_id',
        originalName: 'session_id',
        paramLocation: 'cookie',
        paramSchema: {},
        required: false,
      },
    ];

    const result = prepareRequestParams(endpoint, parameters, {});

    expect(result.headers).toEqual({});
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

function newPetsContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      session: createSession({id: 'session-1', appName: 'app'}),
      pluginManager: new PluginManager(),
    }),
    functionCallId: 'fc-1',
  });
}

function stubFetchResponse(response: Response) {
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
  const fetchSpy = stubFetchResponse(jsonResponse({result: 'ok'}));
  await tool.runAsync({args: {}, toolContext: newPetsContext()});
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
      // The integration branch's parser carries a parameter description into
      // the schema, so the raw schema shows it here.
      properties: {
        limit: {type: 'integer', description: 'How many pets to return.'},
      },
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
      tool.runAsync({args: {}, toolContext: newPetsContext()}),
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

    const fetchSpy = stubFetchResponse(jsonResponse({result: 'ok'}));
    const result = await tool.runAsync({
      args: {},
      toolContext: newPetsContext(),
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
    stubFetchResponse(jsonResponse({error: 'Status Code: 500'}, 500));

    const response = await tool.runAsync({
      args: {},
      toolContext: newPetsContext(),
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
      toolContext: newPetsContext(),
    });

    expect(tool.detectErrorInResponse(response)).toBe('HTTP_ERROR');
  });

  it('should not classify what runAsync returns for a successful request', async () => {
    const tool = newTool();
    stubFetchResponse(jsonResponse({result: 'ok'}));

    const response = await tool.runAsync({
      args: {},
      toolContext: newPetsContext(),
    });

    expect(tool.detectErrorInResponse(response)).toBeUndefined();
  });
});
