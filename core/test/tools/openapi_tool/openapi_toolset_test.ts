/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  AuthHandler,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  OpenApiSpecParser,
  OpenAPIToolset,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';

const FUNCTION_CALL_ID = 'test-function-call';

/** Builds a tool context whose auth requests are keyed by FUNCTION_CALL_ID. */
function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
    }),
    functionCallId: FUNCTION_CALL_ID,
  });
}

/** Returns the resolved `application/json` schema of the `200` response. */
function jsonResponseSchema(
  operation: OpenAPIV3.OperationObject,
): OpenAPIV3.SchemaObject {
  const response = operation.responses?.['200'];
  if (!response || '$ref' in response) {
    expect.fail(
      `expected a resolved 200 response, got ${JSON.stringify(response)}`,
    );
  }
  const schema = response.content?.['application/json']?.schema;
  if (!schema || '$ref' in schema) {
    expect.fail(
      `expected a resolved response schema, got ${JSON.stringify(schema)}`,
    );
  }
  return schema;
}

describe('OpenAPIToolset', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  const authScheme: OpenAPIV3.SecuritySchemeObject = {
    type: 'apiKey',
    name: 'key',
    in: 'header',
  };

  const authCredential: AuthCredential = {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: 'my-key',
  };

  it('should apply global auth overrides', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      authScheme,
      authCredential,
    });
    const tools = await toolset.getTools();

    expect(tools.length).toBe(2);
    for (const tool of tools) {
      const toolContext = createToolContext();
      await tool.runAsync({args: {}, toolContext});

      // A tool with no stored credential asks for one, and the request it
      // publishes carries both overrides: the scheme is what makes it ask at
      // all, and the credential is what it asks with.
      expect(
        toolContext.eventActions.requestedAuthConfigs[FUNCTION_CALL_ID],
      ).toMatchObject({authScheme, rawAuthCredential: authCredential});
    }
  });

  it('should send the overridden api key on the outgoing request', async () => {
    const toolset = new OpenAPIToolset({
      specDict: mockSpec,
      authScheme,
      authCredential,
    });
    const [tool] = await toolset.getTools();
    const toolContext = createToolContext();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('ok'));

    await tool.runAsync({args: {}, toolContext});
    const requested =
      toolContext.eventActions.requestedAuthConfigs[FUNCTION_CALL_ID];
    expect(requested).toBeDefined();
    // Answer the tool's auth request the way a client does, with the very
    // credential it asked for, so the value on the wire traces back to the
    // override rather than to the fixture.
    await new AuthHandler({
      ...requested,
      exchangedAuthCredential: requested.rawAuthCredential,
    }).parseAndStoreAuthResponse(toolContext.state);

    await tool.runAsync({args: {}, toolContext});

    // The header name comes from the overriding scheme and its value from the
    // overriding credential, so one header pins both.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]?.headers).toEqual({key: 'my-key'});
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
    const specWithRef: OpenAPIV3.Document = {
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
    };

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
    const specMissingId: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'Test', version: '1.0'},
      paths: {
        '/test': {
          get: {
            responses: {'200': {description: 'OK'}},
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specMissingId);

    expect(operations.length).toBe(1);
    expect(operations[0].operation.operationId).toBe('get__test');
  });

  it('should extract specific security scheme', () => {
    const specWithSecurity: OpenAPIV3.Document = {
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
    };

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
    const specWithBrokenRef: OpenAPIV3.Document = {
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
    };

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithBrokenRef);

    expect(operations.length).toBe(1);
    expect(operations[0].operation.parameters?.[0]).toEqual({
      $ref: '#/components/parameters/nonexistent',
    });
  });

  it('should handle global security', () => {
    const specWithGlobalSecurity: OpenAPIV3.Document = {
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
    };

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithGlobalSecurity);

    expect(operations.length).toBe(1);
    expect(operations[0].authScheme).toEqual({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('should sanitize invalid schema types', () => {
    const specWithInvalidType: OpenAPIV3.Document = {
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
                        // 'Any' is not an OpenAPI 3.0 schema type; the
                        // parser is expected to strip it. The assertion is
                        // scoped to the type literal alone.
                        invalidProp: {
                          type: 'Any' as OpenAPIV3.NonArraySchemaObjectType,
                        },
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
    };

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithInvalidType);

    expect(operations.length).toBe(1);
    const schema = jsonResponseSchema(operations[0].operation);
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
    const specWithInvalidArrayType: OpenAPIV3.Document = {
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
                        // A list-valued `type` is OpenAPI 3.1 syntax with no
                        // OpenAPI 3.0 typing at all, so the assertion has to
                        // cover the whole property; the parser is expected to
                        // drop the invalid 'Any' member.
                        multiProp: {
                          type: ['string', 'Any', 'integer'],
                        } as unknown as OpenAPIV3.SchemaObject,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    const operations = parser.parse(specWithInvalidArrayType);

    expect(operations.length).toBe(1);
    const schema = jsonResponseSchema(operations[0].operation);
    const multiPropSchema = schema.properties?.[
      'multiProp'
    ] as OpenAPIV3.SchemaObject;
    expect(multiPropSchema.type).toEqual(['string', 'integer']);
  });
});
