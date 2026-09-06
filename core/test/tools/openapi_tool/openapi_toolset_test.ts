/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  Context,
  createSession,
  getLogger,
  InvocationContext,
  LlmAgent,
  Logger,
  OpenApiSpecParser,
  OpenAPIToolset,
  PluginManager,
  ReadonlyContext,
  RestApiTool,
  setLogger,
} from '@google/adk';
import yaml from 'js-yaml';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('OpenAPIToolset', () => {
  const mockSpec: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: {
      title: 'Test API',
      version: '1.0.0',
    },
    servers: [{url: 'https://api.example.com'}],
    paths: {
      '/users': {
        get: {
          operationId: 'getUsers',
          summary: 'Get users',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              description: 'Limit the number of users',
              schema: {type: 'integer'},
            },
          ],
          responses: {
            '200': {
              description: 'Successful response',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: {type: 'string'},
                        name: {type: 'string'},
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          operationId: 'createUser',
          summary: 'Create user',
          requestBody: {
            description: 'User to create',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: {type: 'string'},
                  },
                  required: ['name'],
                },
              },
            },
          },
          responses: {
            '201': {
              description: 'Created',
            },
          },
        },
      },
    },
  };

  it('should parse OpenAPI spec and create tools', async () => {
    const toolset = new OpenAPIToolset({specDict: mockSpec});
    const tools = await toolset.getTools();

    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('get_users');
    expect(tools[1].name).toBe('create_user');
  });

  it('should filter tools', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      toolFilter: ['get_users'],
    });
    const tools = await toolset.getTools();

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('get_users');
  });

  it('should apply prefix', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      prefix: 'test',
    });
    const tools = await toolset.getTools();

    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('test_get_users');
    expect(tools[1].name).toBe('test_create_user');
  });

  it('should apply global auth overrides', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      authScheme: {type: 'apiKey', name: 'key', in: 'header'},
      authCredential: {authType: AuthCredentialTypes.API_KEY, apiKey: 'my-key'},
    });
    const tools = await toolset.getTools();

    expect(tools.length).toBe(2);
    expect((tools[0] as unknown as Record<string, unknown>).authScheme).toEqual(
      {type: 'apiKey', name: 'key', in: 'header'},
    );
    expect(
      (tools[0] as unknown as Record<string, unknown>).authCredential,
    ).toEqual({authType: AuthCredentialTypes.API_KEY, apiKey: 'my-key'});
  });

  it('should return all tools when no toolFilter is set and a context is provided', async () => {
    const toolset = new OpenAPIToolset({specDict: mockSpec});
    const tools = await toolset.getTools({} as unknown as ReadonlyContext);

    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('get_users');
    expect(tools[1].name).toBe('create_user');
  });

  it('should apply a string[] toolFilter when a context is provided', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      toolFilter: ['create_user'],
    });
    const tools = await toolset.getTools({} as unknown as ReadonlyContext);

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('create_user');
  });

  it('should apply a predicate toolFilter when a context is provided', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      toolFilter: (tool) => tool.name === 'get_users',
    });
    const tools = await toolset.getTools({} as unknown as ReadonlyContext);

    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('get_users');
  });

  it('should handle context in getTools', async () => {
    const toolset = new OpenAPIToolset({specDict: mockSpec});
    const mockContext = {};
    (
      toolset as unknown as {
        isToolSelected: (tool: unknown, context: unknown) => boolean;
      }
    ).isToolSelected = () => true;
    const tools = await toolset.getTools(
      mockContext as unknown as ReadonlyContext,
    );
    expect(tools.length).toBe(2);
  });

  it('should call close', async () => {
    const toolset = new OpenAPIToolset({specDict: mockSpec});
    await expect(toolset.close()).resolves.toBeUndefined();
  });
});

describe('OpenApiSpecParser', () => {
  const mockSpec: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info: {title: 'Test', version: '1.0'},
    paths: {
      '/test': {
        get: {
          operationId: 'testOp',
          responses: {'200': {description: 'OK'}},
        },
      },
    },
  };

  it('should parse operations', () => {
    const parser = new OpenApiSpecParser();
    const operations = parser.parse(mockSpec);

    expect(operations.length).toBe(1);
    expect(operations[0].name).toBe('test_op');
  });

  it('should resolve references', () => {
    const specWithRef = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            parameters: [{$ref: '#/components/parameters/limit'}],
            responses: {'200': {description: 'OK'}},
          },
        },
      },
      components: {
        parameters: {
          limit: {
            name: 'limit',
            in: 'query',
            schema: {type: 'integer'},
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithRef);

    expect(operations.length).toBe(1);
    expect(operations[0].operation.parameters?.[0]).toEqual({
      name: 'limit',
      in: 'query',
      schema: {type: 'integer'},
    });
  });

  it('should generate operationId if missing', () => {
    const specMissingId = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            responses: {'200': {description: 'OK'}},
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specMissingId);

    expect(operations.length).toBe(1);
    expect(operations[0].operation.operationId).toBe('get__test');
  });

  it('should extract specific security scheme', () => {
    const specWithSecurity = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            security: [{custom_auth: []}],
            responses: {'200': {description: 'OK'}},
          },
        },
      },
      components: {
        securitySchemes: {
          custom_auth: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithSecurity);

    expect(operations.length).toBe(1);
    expect(operations[0].authScheme).toEqual({
      type: 'apiKey',
      name: 'X-API-Key',
      in: 'header',
    });
  });

  it('should handle broken reference', () => {
    const specWithBrokenRef = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            parameters: [{$ref: '#/components/parameters/nonexistent'}],
            responses: {'200': {description: 'OK'}},
          },
        },
      },
      components: {
        parameters: {},
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithBrokenRef);

    expect(operations.length).toBe(1);
    expect(operations[0].operation.parameters?.[0]).toEqual({
      $ref: '#/components/parameters/nonexistent',
    });
  });

  it('should handle global security', () => {
    const specWithGlobalSecurity = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      security: [{global_auth: []}],
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            responses: {'200': {description: 'OK'}},
          },
        },
      },
      components: {
        securitySchemes: {
          global_auth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithGlobalSecurity);

    expect(operations.length).toBe(1);
    expect(operations[0].authScheme).toEqual({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('should sanitize invalid schema types', () => {
    const specWithInvalidType = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        invalidProp: {type: 'Any'},
                        validProp: {type: 'string'},
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithInvalidType);

    expect(operations.length).toBe(1);
    const response = operations[0].operation.responses?.['200'] as
      | OpenAPIV3.ResponseObject
      | undefined;
    const schema = response?.content?.['application/json']
      ?.schema as OpenAPIV3.SchemaObject;
    const invalidPropSchema = schema.properties?.[
      'invalidProp'
    ] as OpenAPIV3.SchemaObject;
    const validPropSchema = schema.properties?.[
      'validProp'
    ] as OpenAPIV3.SchemaObject;
    expect(invalidPropSchema.type).toBeUndefined();
    expect(validPropSchema.type).toBe('string');
  });

  it('should sanitize invalid schema types in array', () => {
    const specWithInvalidArrayType = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            operationId: 'testOp',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        multiProp: {type: ['string', 'Any', 'integer']},
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithInvalidArrayType);

    expect(operations.length).toBe(1);
    const response = operations[0].operation.responses?.['200'] as
      | OpenAPIV3.ResponseObject
      | undefined;
    const schema = response?.content?.['application/json']
      ?.schema as OpenAPIV3.SchemaObject;
    const multiPropSchema = schema.properties?.[
      'multiProp'
    ] as OpenAPIV3.SchemaObject;
    expect(multiPropSchema.type).toEqual(['string', 'integer']);
  });
});

const usersSpec: OpenAPIV3.Document = {
  openapi: '3.0.0',
  info: {title: 'Users API', version: '1.0.0'},
  servers: [{url: 'https://api.example.com'}],
  paths: {
    '/users': {
      get: {
        operationId: 'getUsers',
        summary: 'Get users',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            description: 'Limit the number of users',
            schema: {type: 'integer'},
          },
          {name: 'firstName', in: 'query', schema: {type: 'string'}},
        ],
        responses: {'200': {description: 'Successful response'}},
      },
    },
  },
};

const apiKeyScheme: OpenAPIV3.ApiKeySecurityScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
};

const securedSpec: OpenAPIV3.Document = {
  openapi: '3.0.0',
  info: {title: 'Profile API', version: '1.0.0'},
  servers: [{url: 'https://api.example.com'}],
  security: [{ApiKeyAuth: []}],
  paths: {
    '/profile': {
      get: {
        operationId: 'getProfile',
        responses: {'200': {description: 'Successful response'}},
      },
    },
  },
  components: {securitySchemes: {ApiKeyAuth: apiKeyScheme}},
};

const apiKeyCredential: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'secret-key',
};

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

function createFetchStub() {
  return vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response('{"ok":true}', {
        headers: {'content-type': 'application/json'},
      }),
  );
}

describe('OpenAPIToolset.getTool', () => {
  it('should return the tool with the requested name', () => {
    const toolset = new OpenAPIToolset({specDict: usersSpec});

    const tool = toolset.getTool('get_users');

    if (!tool) expect.fail('get_users tool was not created');
    expect(tool.name).toBe('get_users');
    expect(tool.description).toBe('Get users');
    expect(tool._getDeclaration().parameters?.properties).toHaveProperty(
      'limit',
    );
  });

  it('should return undefined for a name no tool carries', () => {
    const toolset = new OpenAPIToolset({specDict: usersSpec});

    expect(toolset.getTool('no_such_tool')).toBeUndefined();
  });

  it('should match the prefixed name, not the spec name', () => {
    const toolset = new OpenAPIToolset({specDict: usersSpec, prefix: 'test'});

    expect(toolset.getTool('test_get_users')?.name).toBe('test_get_users');
    expect(toolset.getTool('get_users')).toBeUndefined();
  });
});

describe('OpenAPIToolset spec loading', () => {
  it('should build the same tools from a YAML string as from a spec object', async () => {
    const toolset = new OpenAPIToolset({
      specStr: yaml.dump(usersSpec),
      specType: 'yaml',
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['get_users']);
  });

  it('should parse a leading --- document as YAML without a specType', async () => {
    const toolset = new OpenAPIToolset({
      specStr: `---\n${yaml.dump(usersSpec)}`,
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['get_users']);
  });

  it('should parse a spec string as JSON by default', async () => {
    const toolset = new OpenAPIToolset({specStr: JSON.stringify(usersSpec)});

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['get_users']);
  });

  it('should reject a JSON spec string that holds an array', () => {
    expect(() => new OpenAPIToolset({specStr: '[]'})).toThrow(
      'The OpenAPI specification must be an object',
    );
  });

  it('should reject a JSON spec string that holds null', () => {
    expect(() => new OpenAPIToolset({specStr: 'null'})).toThrow(
      'The OpenAPI specification must be an object',
    );
  });

  it('should reject a JSON spec string that holds a string', () => {
    expect(() => new OpenAPIToolset({specStr: '"text"'})).toThrow(
      'The OpenAPI specification must be an object',
    );
  });

  it('should reject a YAML spec string that holds a scalar', () => {
    expect(
      () => new OpenAPIToolset({specStr: 'just-a-scalar', specType: 'yaml'}),
    ).toThrow('The OpenAPI specification must be an object');
  });

  it('should propagate a JSON syntax error', () => {
    expect(() => new OpenAPIToolset({specStr: '{'})).toThrow(SyntaxError);
  });

  it('should reject a toolset built without a spec', () => {
    expect(() => new OpenAPIToolset()).toThrow(
      'Either specDict or specStr must be provided.',
    );
  });

  it('should log the name of every parsed tool', () => {
    const debug = vi.fn();
    const recordingLogger: Logger = {
      log: vi.fn(),
      debug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLogLevel: vi.fn(),
    };
    const previousLogger = getLogger();
    setLogger(recordingLogger);

    try {
      new OpenAPIToolset({specDict: usersSpec});
    } finally {
      setLogger(previousLogger);
    }

    expect(debug).toHaveBeenCalledWith('Parsed tool: get_users');
  });
});

describe('OpenAPIToolset transport', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = createFetchStub();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('should call the injected fetch instead of the global one', async () => {
    const fetchFn = createFetchStub();
    const toolset = new OpenAPIToolset({specDict: usersSpec, fetchFn});
    const tool = toolset.getTool('get_users');
    if (!tool) expect.fail('get_users tool was not created');

    await tool.runAsync({args: {limit: 5}, toolContext: createToolContext()});

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/users?limit=5',
      expect.objectContaining({method: 'GET'}),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('should route later calls to the fetch configureFetchAll installs', async () => {
    const initialFetch = createFetchStub();
    const replacementFetch = createFetchStub();
    const toolset = new OpenAPIToolset({
      specDict: usersSpec,
      fetchFn: initialFetch,
    });
    const tool = toolset.getTool('get_users');
    if (!tool) expect.fail('get_users tool was not created');

    toolset.configureFetchAll(replacementFetch);
    await tool.runAsync({args: {limit: 5}, toolContext: createToolContext()});

    expect(replacementFetch).toHaveBeenCalledOnce();
    expect(initialFetch).not.toHaveBeenCalled();
  });

  it('should call the global fetch when none is injected', async () => {
    const toolset = new OpenAPIToolset({specDict: usersSpec});
    const tool = toolset.getTool('get_users');
    if (!tool) expect.fail('get_users tool was not created');

    await tool.runAsync({args: {limit: 5}, toolContext: createToolContext()});

    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it('should send the headers the headerProvider returns', async () => {
    const fetchFn = createFetchStub();
    const toolset = new OpenAPIToolset({
      specDict: usersSpec,
      fetchFn,
      headerProvider: () => ({'X-Correlation-Id': 'abc-123'}),
    });
    const tool = toolset.getTool('get_users');
    if (!tool) expect.fail('get_users tool was not created');

    await tool.runAsync({args: {}, toolContext: createToolContext()});

    expect(fetchFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({headers: {'X-Correlation-Id': 'abc-123'}}),
    );
  });

  it('should send no extra headers without a headerProvider', async () => {
    const fetchFn = createFetchStub();
    const toolset = new OpenAPIToolset({specDict: usersSpec, fetchFn});
    const tool = toolset.getTool('get_users');
    if (!tool) expect.fail('get_users tool was not created');

    await tool.runAsync({args: {}, toolContext: createToolContext()});

    expect(fetchFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({headers: {}}),
    );
  });
});

describe('OpenAPIToolset credentials', () => {
  it('should send the API key the toolset was configured with', async () => {
    const fetchFn = createFetchStub();
    const toolset = new OpenAPIToolset({
      specDict: securedSpec,
      authScheme: apiKeyScheme,
      authCredential: apiKeyCredential,
      fetchFn,
    });
    const tool = toolset.getTool('get_profile');
    if (!tool) expect.fail('get_profile tool was not created');

    await tool.runAsync({args: {}, toolContext: createToolContext()});

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.example.com/profile',
      expect.objectContaining({headers: {'X-API-Key': 'secret-key'}}),
    );
  });

  it('should look the credential up under the configured credential key', async () => {
    const fetchFn = createFetchStub();
    const toolset = new OpenAPIToolset({
      specDict: securedSpec,
      authScheme: apiKeyScheme,
      authCredential: apiKeyCredential,
      credentialKey: 'my-key',
      fetchFn,
    });
    const tool = toolset.getTool('get_profile');
    if (!tool) expect.fail('get_profile tool was not created');
    const context = createToolContext();
    const getAuthResponse = vi.spyOn(context, 'getAuthResponse');

    await tool.runAsync({args: {}, toolContext: context});

    expect(getAuthResponse).toHaveBeenCalledWith(
      expect.objectContaining({credentialKey: 'my-key'}),
    );
  });

  it('should replace the credential key on every tool', async () => {
    const fetchFn = createFetchStub();
    const toolset = new OpenAPIToolset({
      specDict: securedSpec,
      authScheme: apiKeyScheme,
      authCredential: apiKeyCredential,
      credentialKey: 'my-key',
      fetchFn,
    });
    const tool = toolset.getTool('get_profile');
    if (!tool) expect.fail('get_profile tool was not created');
    const context = createToolContext();
    const getAuthResponse = vi.spyOn(context, 'getAuthResponse');

    toolset.configureCredentialKeyAll('rotated-key');
    await tool.runAsync({args: {}, toolContext: context});

    expect(getAuthResponse).toHaveBeenCalledWith(
      expect.objectContaining({credentialKey: 'rotated-key'}),
    );
  });
});

describe('OpenAPIToolset property names', () => {
  it('should convert a property name to snake_case by default', async () => {
    const toolset = new OpenAPIToolset({specDict: usersSpec});

    const [tool] = await toolset.getTools();

    const properties = tool._getDeclaration().parameters?.properties;
    expect(properties).toHaveProperty('first_name');
    expect(properties).not.toHaveProperty('firstName');
  });

  it('should keep the original property name when asked to', async () => {
    const toolset = new OpenAPIToolset({
      specDict: usersSpec,
      preservePropertyNames: true,
    });

    const [tool] = await toolset.getTools();

    const properties = tool._getDeclaration().parameters?.properties;
    expect(properties).toHaveProperty('firstName');
    expect(properties).not.toHaveProperty('first_name');
  });
});

describe('OpenAPIToolset.getTools', () => {
  it('should warn and return all tools for a predicate filter with no context', async () => {
    const warn = vi.fn();
    const recordingLogger: Logger = {
      log: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      setLogLevel: vi.fn(),
    };
    const toolset = new OpenAPIToolset({
      specDict: usersSpec,
      toolFilter: () => false,
    });
    const previousLogger = getLogger();
    setLogger(recordingLogger);

    let tools: RestApiTool[];
    try {
      tools = await toolset.getTools();
    } finally {
      setLogger(previousLogger);
    }

    expect(tools.map((tool) => tool.name)).toEqual(['get_users']);
    expect(warn).toHaveBeenCalledWith(
      'OpenAPIToolset: a ToolPredicate toolFilter was provided but getTools() ' +
        'was called without a ReadonlyContext. The filter will not be applied.',
    );
  });

  it('should return a copy the caller cannot use to drop a tool', async () => {
    const toolset = new OpenAPIToolset({specDict: usersSpec});

    (await toolset.getTools()).length = 0;

    expect(await toolset.getTools()).toHaveLength(1);
  });
});
