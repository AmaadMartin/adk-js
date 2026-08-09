/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  createRestApiTool,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RestApiTool,
  ToolAuthHandler,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  prepareRequestBody,
  prepareRequestParams,
} from '../../../src/tools/openapi_tool/rest_api_tool.js';

/** Builds a real tool context, so no cast is needed to invoke a tool. */
function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('RestApiTool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should pass the configured credential key to the auth handler', async () => {
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
    const toolContext = createToolContext();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: {get: () => 'text/plain'},
      text: async () => 'ok',
    });
    const spy = vi.spyOn(ToolAuthHandler, 'fromToolContext');

    tool.configureCredentialKey('my-credential-key');
    await tool.runAsync({args: {}, toolContext});

    expect(spy).toHaveBeenCalledWith(toolContext, undefined, undefined, {
      credentialKey: 'my-credential-key',
    });
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

    const toolContext = createToolContext();
    await tool.runAsync({
      args: {},
      toolContext,
    });

    expect(headerProvider).toHaveBeenCalledWith(toolContext);
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
    const operation: OpenAPIV3.OperationObject = {
      responses: {},
      requestBody: {
        content: {'application/json': {schema: {type: 'object'}}},
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

    await tool.runAsync({
      args: {body: {foo: 'bar'}},
      toolContext: createToolContext(),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({'Content-Type': 'application/json'}),
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
    const operation: OpenAPIV3.OperationObject = {
      responses: {},
      parameters: [
        {name: 'id', in: 'path', required: true, schema: {type: 'string'}},
      ],
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

    await tool.runAsync({
      args: {id: '123'},
      toolContext: createToolContext(),
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
    const operation: OpenAPIV3.OperationObject = {
      responses: {},
      requestBody: {
        content: {
          'application/json': {
            schema: {type: 'object', properties: {user: {type: 'object'}}},
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

    await tool.runAsync({
      args: {user: {name: 'Alice'}},
      toolContext: createToolContext(),
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

    const toolContext = createToolContext();
    const authHandler = new ToolAuthHandler(toolContext);
    vi.spyOn(authHandler, 'prepareAuthCredentials').mockResolvedValue({
      state: 'pending',
    });
    vi.spyOn(ToolAuthHandler, 'fromToolContext').mockReturnValue(authHandler);

    const result = await tool.runAsync({
      args: {},
      toolContext,
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
    const operation: OpenAPIV3.OperationObject = {
      responses: {},
      parameters: [{name: 'traceId', in: 'header', schema: {type: 'string'}}],
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

    await tool.runAsync({
      args: {trace_id: 'trace-123'},
      toolContext: createToolContext(),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({traceId: 'trace-123'}),
      }),
    );
  });

  it('should get declaration', () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {
      operationId: 'get_user',
      parameters: [
        {name: 'userId', in: 'path', required: true, schema: {type: 'string'}},
      ],
      responses: {},
    };
    const tool = new RestApiTool(
      'test_tool',
      'description',
      endpoint,
      operation,
    );

    expect(tool._getDeclaration()).toEqual({
      name: 'test_tool',
      description: 'description',
      parameters: {
        type: 'object',
        properties: {user_id: {type: 'string'}},
        required: ['user_id'],
        title: 'get_user_Arguments',
      },
    });
  });

  it('should extract query parameters from path', async () => {
    const endpoint = {
      baseUrl: 'http://api.example.com',
      path: '/test?existing=param',
      method: 'GET',
    };
    const operation: OpenAPIV3.OperationObject = {
      responses: {},
      parameters: [{name: 'new_param', in: 'query', schema: {type: 'string'}}],
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

    await tool.runAsync({
      args: {new_param: 'value'},
      toolContext: createToolContext(),
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://api.example.com/test?new_param=value&existing=param',
      expect.anything(),
    );
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
            schema: {
              type: 'object',
              properties: {foo: {type: 'string'}, baz: {type: 'string'}},
            },
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

    await tool.runAsync({
      args: {foo: 'bar', baz: 'qux'},
      toolContext: createToolContext(),
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
            schema: {
              type: 'object',
              properties: {foo: {type: 'string'}, file: {type: 'string'}},
            },
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

    await tool.runAsync({
      args: {foo: 'bar', file: 'content'},
      toolContext: createToolContext(),
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
      toolContext: createToolContext(),
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

    const toolContext = createToolContext();
    const authHandler = new ToolAuthHandler(toolContext);
    vi.spyOn(authHandler, 'prepareAuthCredentials').mockResolvedValue({
      state: 'done',
      authCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret_key',
      },
    });
    vi.spyOn(ToolAuthHandler, 'fromToolContext').mockReturnValue(authHandler);

    await tool.runAsync({
      args: {},
      toolContext,
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({'X-API-Key': 'secret_key'}),
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
      toolContext: createToolContext(),
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

    const authScheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    };
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

    const toolContext = createToolContext();
    const authHandler = new ToolAuthHandler(toolContext);
    vi.spyOn(authHandler, 'prepareAuthCredentials').mockResolvedValue({
      state: 'done',
      authCredential,
    });
    const spy = vi
      .spyOn(ToolAuthHandler, 'fromToolContext')
      .mockReturnValue(authHandler);

    await tool.runAsync({
      args: {},
      toolContext,
    });

    expect(spy).toHaveBeenCalledWith(
      toolContext,
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

    it('should return no body when the operation declares no requestBody', () => {
      const body = {foo: 'bar'};
      const bodyData = {};
      const headers = {};

      const result = prepareRequestBody(undefined, body, bodyData, headers);

      expect(result).toBeUndefined();
      expect(headers).toEqual({});
    });

    it('should return no body when requestBody declares no content', () => {
      const requestBody = {} as OpenAPIV3.RequestBodyObject; // defined but no content
      const body = {foo: 'bar'};
      const bodyData = {};
      const headers = {};

      const result = prepareRequestBody(requestBody, body, bodyData, headers);

      expect(result).toBeUndefined();
      expect(headers).toEqual({});
    });
  });
});
