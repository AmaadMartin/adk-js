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
  DEFAULT_OPENAPI_CREDENTIAL_KEY,
  HttpDispatcher,
  InvocationContext,
  LlmAgent,
  OpenApiSpecParser,
  OpenAPIToolset,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import yaml from 'js-yaml';
import {OpenAPIV3} from 'openapi-types';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockedFunction,
  vi,
} from 'vitest';

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

const paritySpec: OpenAPIV3.Document = {
  openapi: '3.0.0',
  info: {title: 'Users API', version: '1.0.0'},
  servers: [{url: 'https://api.example.com'}],
  paths: {
    '/users': {
      get: {
        operationId: 'getUsers',
        summary: 'Get users',
        responses: {'200': {description: 'OK'}},
      },
      post: {
        operationId: 'createUser',
        summary: 'Create user',
        responses: {'201': {description: 'Created'}},
      },
    },
  },
};

const apiKeyScheme: OpenAPIV3.ApiKeySecurityScheme = {
  type: 'apiKey',
  name: 'key',
  in: 'header',
};

const apiKeyCredential: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'my-key',
};

/** A dispatcher the application built itself. */
const fakeDispatcher: HttpDispatcher = {dispatch: () => true};

/**
 * Widens a `specType` the way an untyped JavaScript caller reaches the
 * constructor. TypeScript rejects the literal at the call site, so the
 * `Unsupported spec type` guard is unreachable without this.
 */
function untypedSpecType(specType: string): 'json' | 'yaml' {
  return specType as 'json' | 'yaml';
}

function newToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'invocation-1',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'session-1', appName: 'test_app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('OpenAPIToolset.getTool', () => {
  it('returns the tool with that name', () => {
    const toolset = new OpenAPIToolset({specDict: paritySpec});

    expect(toolset.getTool('get_users')?.name).toBe('get_users');
  });

  it('returns undefined for a name it did not generate', () => {
    const toolset = new OpenAPIToolset({specDict: paritySpec});

    expect(toolset.getTool('delete_users')).toBeUndefined();
  });

  it('matches the prefixed name, not the bare one', () => {
    const toolset = new OpenAPIToolset({specDict: paritySpec, prefix: 'test'});

    expect(toolset.getTool('test_get_users')?.name).toBe('test_get_users');
    expect(toolset.getTool('get_users')).toBeUndefined();
  });
});

describe('OpenAPIToolset sslVerify', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: MockedFunction<typeof globalThis.fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response('{}', {headers: {'content-type': 'application/json'}}),
    );
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Runs every tool the toolset exposes and returns the `fetch` options. */
  async function runAll(toolset: OpenAPIToolset) {
    for (const tool of await toolset.getTools()) {
      await tool.runAsync({args: {}, toolContext: newToolContext()});
    }
    return fetchMock.mock.calls.map(([, init]) => init ?? {});
  }

  it('sends no dispatcher when the toolset sets no sslVerify', async () => {
    const inits = await runAll(new OpenAPIToolset({specDict: paritySpec}));

    expect(inits).toHaveLength(2);
    for (const init of inits) {
      expect(init).not.toHaveProperty('dispatcher');
    }
  });

  it('sends the constructor dispatcher on every tool', async () => {
    const inits = await runAll(
      new OpenAPIToolset({specDict: paritySpec, sslVerify: fakeDispatcher}),
    );

    expect(inits).toHaveLength(2);
    for (const init of inits) {
      expect(init).toEqual(
        expect.objectContaining({dispatcher: fakeDispatcher}),
      );
    }
  });

  it('sends the dispatcher configureSslVerifyAll set on every tool', async () => {
    const toolset = new OpenAPIToolset({specDict: paritySpec});
    toolset.configureSslVerifyAll(fakeDispatcher);

    const inits = await runAll(toolset);

    expect(inits).toHaveLength(2);
    for (const init of inits) {
      expect(init).toEqual(
        expect.objectContaining({dispatcher: fakeDispatcher}),
      );
    }
  });

  it('clears a configured dispatcher when called with no argument', async () => {
    const toolset = new OpenAPIToolset({
      specDict: paritySpec,
      sslVerify: fakeDispatcher,
    });
    toolset.configureSslVerifyAll();

    const inits = await runAll(toolset);

    expect(inits).toHaveLength(2);
    for (const init of inits) {
      expect(init).not.toHaveProperty('dispatcher');
    }
  });
});

describe('OpenAPIToolset.getAuthConfig', () => {
  it('reports the scheme, credential and key it was given', () => {
    const toolset = new OpenAPIToolset({
      specDict: paritySpec,
      authScheme: apiKeyScheme,
      authCredential: apiKeyCredential,
      credentialKey: 'my-api',
    });

    expect(toolset.getAuthConfig()).toEqual({
      authScheme: apiKeyScheme,
      rawAuthCredential: apiKeyCredential,
      credentialKey: 'my-api',
    });
  });

  it('falls back to the default credential key', () => {
    const toolset = new OpenAPIToolset({
      specDict: paritySpec,
      authScheme: apiKeyScheme,
    });

    expect(toolset.getAuthConfig()?.credentialKey).toBe(
      DEFAULT_OPENAPI_CREDENTIAL_KEY,
    );
  });

  it('reports no config when only a credential was given', () => {
    const toolset = new OpenAPIToolset({
      specDict: paritySpec,
      authCredential: apiKeyCredential,
    });

    expect(toolset.getAuthConfig()).toBeUndefined();
  });
});

describe('OpenAPIToolset spec loading', () => {
  it('reads an explicit JSON spec string', async () => {
    const toolset = new OpenAPIToolset({
      specStr: JSON.stringify(paritySpec),
      specType: 'json',
    });

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'get_users',
      'create_user',
    ]);
  });

  it('reads a YAML spec string that opens with a document marker', async () => {
    const toolset = new OpenAPIToolset({
      specStr: `---\n${yaml.dump(paritySpec)}`,
    });

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'get_users',
      'create_user',
    ]);
  });

  it('rejects a spec type it cannot parse', () => {
    expect(
      () =>
        new OpenAPIToolset({
          specStr: JSON.stringify(paritySpec),
          specType: untypedSpecType('xml'),
        }),
    ).toThrow('Unsupported spec type: xml');
  });

  it('rejects a JSON spec string that parses to a scalar', () => {
    expect(
      () => new OpenAPIToolset({specStr: '"a string"', specType: 'json'}),
    ).toThrow('The OpenAPI specification must be an object');
  });

  it('rejects a JSON spec string that parses to null', () => {
    expect(
      () => new OpenAPIToolset({specStr: 'null', specType: 'json'}),
    ).toThrow('The OpenAPI specification must be an object');
  });

  it('rejects a JSON spec string that parses to an array', () => {
    expect(() => new OpenAPIToolset({specStr: '[]', specType: 'json'})).toThrow(
      'The OpenAPI specification must be an object',
    );
  });

  it('rejects a YAML spec string that parses to a scalar', () => {
    expect(
      () => new OpenAPIToolset({specStr: 'a string', specType: 'yaml'}),
    ).toThrow('The OpenAPI specification must be an object');
  });

  it('rejects a toolset built with no spec at all', () => {
    expect(() => new OpenAPIToolset()).toThrow(
      'Either specDict or specStr must be provided.',
    );
  });
});

describe('OpenAPIToolset predicate filter without a context', () => {
  it('applies the predicate when getTools is called with no context', async () => {
    const toolset = new OpenAPIToolset({
      specDict: paritySpec,
      toolFilter: (tool) => tool.name === 'get_users',
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['get_users']);
  });

  it('passes no context to the predicate outside an invocation', async () => {
    const seen: Array<ReadonlyContext | undefined> = [];
    const toolset = new OpenAPIToolset({
      specDict: paritySpec,
      toolFilter: (tool, readonlyContext) => {
        seen.push(readonlyContext);
        return true;
      },
    });

    await toolset.getTools();

    expect(seen).toEqual([undefined, undefined]);
  });
});
