/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenApiSpecParser, ParsedOperation} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

/**
 * Mirrors the minimal fixture of adk-python's spec parser tests: one `get`
 * operation on `/test` that returns a string.
 */
function createMinimalOpenApiSpec(): OpenAPIV3.Document {
  return {
    openapi: '3.0.0',
    info: {title: 'Minimal API', version: '1.0.0'},
    paths: {
      '/test': {
        get: {
          summary: 'Test GET endpoint',
          operationId: 'testGet',
          responses: {
            '200': {
              description: 'Successful response',
              content: {'application/json': {schema: {type: 'string'}}},
            },
          },
        },
      },
    },
  };
}

/**
 * Reads a resolved property of a schema, failing the test when the property is
 * missing or is still an unresolved reference.
 */
function schemaProperty(
  schema: OpenAPIV3.SchemaObject,
  name: string,
): OpenAPIV3.SchemaObject {
  const property = schema.properties?.[name];
  if (!property || '$ref' in property) {
    expect.fail(`schema has no resolved property '${name}'`);
  }
  return property;
}

/**
 * Parses a value the `parse` signature rejects, so a test can exercise the
 * runtime guard that protects callers without type checking.
 */
function parseUntyped(value: unknown): ParsedOperation[] {
  return new OpenApiSpecParser().parse(value as OpenAPIV3.Document);
}

describe('OpenApiSpecParser', () => {
  it('should resolve internal references', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'Test API', version: '1.0.0'},
      paths: {
        '/test': {
          post: {
            operationId: 'testOp',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/User',
                  },
                },
              },
            },
            responses: {},
          },
        },
      },
      components: {
        schemas: {
          User: {
            type: 'object',
            properties: {
              name: {type: 'string'},
            },
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    const parsed = parser.parse(spec);

    expect(parsed.length).toBe(1);
    const op = parsed[0];
    expect(op.operation.requestBody).toBeDefined();
    const body = op.operation.requestBody as OpenAPIV3.RequestBodyObject;
    const schema = body.content['application/json']
      .schema as OpenAPIV3.SchemaObject;
    expect(schema.type).toBe('object');
    expect(schema.properties?.name).toBeDefined();
  });

  it('should handle circular references and break the cycle', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'Circular API', version: '1.0.0'},
      paths: {
        '/node': {
          get: {
            operationId: 'getNode',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      $ref: '#/components/schemas/Node',
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: {
              value: {type: 'string'},
              next: {
                $ref: '#/components/schemas/Node',
              },
            },
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    const parsed = parser.parse(spec);

    expect(parsed.length).toBe(1);
    const op = parsed[0];
    expect(op.operation.responses['200']).toBeDefined();
  });

  it('should throw error for external references', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'External API', version: '1.0.0'},
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      $ref: 'https://example.com/schemas/User.json',
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
    expect(() => parser.parse(spec)).toThrow(
      'External references not supported',
    );
  });

  it('should sanitize schema types', () => {
    // Declares schema types the OpenAPI typings reject, because normalizing
    // exactly those is what is under test.
    const spec = {
      openapi: '3.0.0',
      info: {title: 'Sanitize API', version: '1.0.0'},
      paths: {
        '/sanitize': {
          post: {
            operationId: 'sanitizeOp',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'OBJECT', // uppercase, should be normalized
                    properties: {
                      age: {type: 'INTEGER'}, // uppercase, should be normalized
                      invalid: {type: 'unknown_type'}, // invalid, should be removed
                    },
                  },
                },
              },
            },
            responses: {},
          },
        },
      },
    } as unknown as OpenAPIV3.Document;

    const parser = new OpenApiSpecParser();
    const parsed = parser.parse(spec);

    expect(parsed.length).toBe(1);
    const op = parsed[0];
    const body = op.operation.requestBody as OpenAPIV3.RequestBodyObject;
    const schema = body.content['application/json']
      .schema as OpenAPIV3.SchemaObject;
    expect(schema.type).toBe('object');
    expect(
      (schema.properties?.age as OpenAPIV3.SchemaObject | undefined)?.type,
    ).toBe('integer');
    expect(
      (schema.properties?.invalid as OpenAPIV3.SchemaObject).type,
    ).toBeUndefined();
  });

  it('should merge path-level parameters and generate operationId if missing', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'Param API', version: '1.0.0'},
      paths: {
        '/users/{id}': {
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: {type: 'string'},
            },
          ],
          get: {
            // operationId is missing, so it is synthesized as "users_id_get"
            responses: {},
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    const parsed = parser.parse(spec);

    expect(parsed.length).toBe(1);
    const op = parsed[0];
    expect(op.name).toBe('users_id_get');
    expect(op.parameters.length).toBe(1);
    expect(op.parameters[0].name).toBe('id');
  });

  it('should resolve security schemes', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'Security API', version: '1.0.0'},
      security: [{ApiKeyAuth: []}], // Global security
      paths: {
        '/secure': {
          get: {
            operationId: 'secureOp',
            responses: {},
          },
          post: {
            operationId: 'securePostOp',
            security: [{OAuth2Auth: []}], // Override security
            responses: {},
          },
        },
      },
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-KEY',
          },
          OAuth2Auth: {
            type: 'oauth2',
            flows: {},
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    const parsed = parser.parse(spec);

    expect(parsed.length).toBe(2);

    // GET secureOp should use global ApiKeyAuth
    const getOp = parsed.find((o) => o.name === 'secure_op');
    expect(getOp).toBeDefined();
    expect(getOp?.authScheme?.type).toBe('apiKey');

    // POST securePostOp should use OAuth2Auth override
    const postOp = parsed.find((o) => o.name === 'secure_post_op');
    expect(postOp).toBeDefined();
    expect(postOp?.authScheme?.type).toBe('oauth2');
  });

  describe('server URL resolution', () => {
    function parseBaseUrl(servers?: OpenAPIV3.ServerObject[]): string {
      const spec: OpenAPIV3.Document = {
        openapi: '3.0.0',
        info: {title: 'Server API', version: '1.0.0'},
        ...(servers ? {servers} : {}),
        paths: {
          '/v1/data': {get: {operationId: 'getData', responses: {}}},
        },
      };

      const parsed = new OpenApiSpecParser().parse(spec);
      expect(parsed.length).toBe(1);
      return parsed[0].endpoint.baseUrl;
    }

    it('should resolve server variables from their default values', () => {
      const baseUrl = parseBaseUrl([
        {
          url: 'https://{region}.api.example.com/{version}',
          variables: {
            region: {default: 'us-central1'},
            version: {default: 'v1'},
          },
        },
      ]);

      expect(baseUrl).toBe('https://us-central1.api.example.com/v1');
    });

    it('should fall back to the first enum entry when the default is empty', () => {
      const baseUrl = parseBaseUrl([
        {
          url: 'https://{region}.api.example.com',
          variables: {
            region: {default: '', enum: ['us-central1', 'europe-west1']},
          },
        },
      ]);

      expect(baseUrl).toBe('https://us-central1.api.example.com');
    });

    it('should throw naming a placeholder that has no declared variable', () => {
      expect(() =>
        parseBaseUrl([{url: 'https://{region}.api.example.com'}]),
      ).toThrow(/region/);
    });

    it('should throw when a declared variable supplies no default or enum', () => {
      expect(() =>
        parseBaseUrl([
          {
            url: 'https://{region}.api.example.com',
            variables: {region: {default: ''}},
          },
        ]),
      ).toThrow(/region/);
    });

    it('should throw naming the unresolved placeholder when others resolve', () => {
      expect(() =>
        parseBaseUrl([
          {
            url: 'https://{region}.api.{tld}',
            variables: {region: {default: 'us'}},
          },
        ]),
      ).toThrow(
        "Unresolved server URL variable 'tld' in 'https://{region}.api.{tld}'. " +
          'Declare a default under servers[].variables.',
      );
    });

    it('should default the base URL to an empty string when the spec has no servers', () => {
      expect(parseBaseUrl()).toBe('');
    });

    it('should use a plain server URL unchanged', () => {
      expect(parseBaseUrl([{url: 'https://api.example.com'}])).toBe(
        'https://api.example.com',
      );
    });
  });

  describe('parsed operation output', () => {
    it('should parse a minimal spec', () => {
      const parsed = new OpenApiSpecParser().parse(createMinimalOpenApiSpec());

      expect(parsed.length).toBe(1);
      expect(parsed[0].name).toBe('test_get');
      expect(parsed[0].endpoint.path).toBe('/test');
      expect(parsed[0].endpoint.method).toBe('get');
      expect(parsed[0].returnValue.paramSchema.type).toBe('string');
    });

    it('should parse every method declared on a path', () => {
      const spec = createMinimalOpenApiSpec();
      spec.paths['/test']!.post = {
        summary: 'Test POST endpoint',
        operationId: 'testPost',
        responses: {'200': {description: 'Successful response'}},
      };

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed.map((op) => op.name)).toEqual(['test_get', 'test_post']);
    });

    it('should synthesize a missing operationId the way adk-python does', () => {
      const spec: OpenAPIV3.Document = {
        openapi: '3.0.0',
        info: {title: 'Synthesis API', version: '1.0.0'},
        paths: {
          '/test': {get: {responses: {}}},
          '/users/{id}': {get: {responses: {}}},
          '/v1/getUsers': {post: {responses: {}}},
          '/a-b/c.d': {delete: {responses: {}}},
        },
      };

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed.map((op) => op.operation.operationId)).toEqual([
        'test_get',
        'users_id_get',
        'v1_get_users_post',
        'a_b_c_d_delete',
      ]);
      expect(parsed.map((op) => op.name)).toEqual([
        'test_get',
        'users_id_get',
        'v1_get_users_post',
        'a_b_c_d_delete',
      ]);
    });

    it('should keep an operationId the spec declares', () => {
      const parsed = new OpenApiSpecParser().parse(createMinimalOpenApiSpec());

      expect(parsed[0].operation.operationId).toBe('testGet');
      expect(parsed[0].name).toBe('test_get');
    });

    it('should synthesize a distinct id for each method on one path', () => {
      const spec: OpenAPIV3.Document = {
        openapi: '3.0.0',
        info: {title: 'Methods API', version: '1.0.0'},
        paths: {'/test': {get: {responses: {}}, post: {responses: {}}}},
      };

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed.map((op) => op.name)).toEqual(['test_get', 'test_post']);
    });

    it('should return an empty schema when the operation declares no responses', () => {
      // A spec file may omit `responses` even though the OpenAPI typings
      // require it, so the parser has to survive the omission.
      const spec = JSON.parse(
        '{"openapi":"3.0.0","info":{"title":"No Responses API",' +
          '"version":"1.0.0"},"paths":{"/test":{"get":{"operationId":' +
          '"testGet"}}}}',
      ) as OpenAPIV3.Document;

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].returnValue.paramSchema).toEqual({});
      expect(parsed[0].returnValue.name).toBe('return');
    });

    it('should return an empty schema for a 2xx response with no content', () => {
      const spec = createMinimalOpenApiSpec();
      spec.paths['/test']!.get!.responses = {'204': {description: 'No body'}};

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].returnValue.paramSchema).toEqual({});
    });

    it('should parse operation parameters with their locations', () => {
      const spec = createMinimalOpenApiSpec();
      spec.paths['/test']!.get!.parameters = [
        {name: 'param1', in: 'query', schema: {type: 'string'}},
        {name: 'param2', in: 'header', schema: {type: 'integer'}},
      ];

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].parameters.length).toBe(2);
      expect(parsed[0].parameters[0].originalName).toBe('param1');
      expect(parsed[0].parameters[0].paramLocation).toBe('query');
      expect(parsed[0].parameters[1].originalName).toBe('param2');
      expect(parsed[0].parameters[1].paramLocation).toBe('header');
    });

    it('should flatten a request body into parameters', () => {
      const spec = createMinimalOpenApiSpec();
      spec.paths['/test']!.post = {
        summary: 'Endpoint with request body',
        operationId: 'testPostWithBody',
        requestBody: {
          content: {
            'application/json': {
              schema: {type: 'object', properties: {name: {type: 'string'}}},
            },
          },
        },
        responses: {'200': {description: 'OK'}},
      };

      const parsed = new OpenApiSpecParser().parse(spec);
      const postOp = parsed.filter((op) => op.endpoint.method === 'post');

      expect(postOp.length).toBe(1);
      expect(postOp[0].name).toBe('test_post_with_body');
      expect(postOp[0].parameters.length).toBe(1);
      expect(postOp[0].parameters[0].originalName).toBe('name');
      expect(postOp[0].parameters[0].paramSchema.type).toBe('string');
    });

    it('should combine path-level and operation-level parameters', () => {
      const spec: OpenAPIV3.Document = {
        openapi: '3.0.0',
        info: {title: 'Combine Parameters API', version: '1.0.0'},
        paths: {
          '/test': {
            parameters: [
              {name: 'global_param', in: 'query', schema: {type: 'string'}},
            ],
            get: {
              operationId: 'testGet',
              parameters: [
                {name: 'local_param', in: 'header', schema: {type: 'integer'}},
              ],
              responses: {'200': {description: 'OK'}},
            },
          },
        },
      };

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].parameters.length).toBe(2);
      const globalParam = parsed[0].parameters.find(
        (param) => param.originalName === 'global_param',
      );
      const localParam = parsed[0].parameters.find(
        (param) => param.originalName === 'local_param',
      );
      expect(globalParam?.paramLocation).toBe('query');
      expect(globalParam?.paramSchema.type).toBe('string');
      expect(localParam?.paramLocation).toBe('header');
      expect(localParam?.paramSchema.type).toBe('integer');
    });

    it('should keep both parameters when a query and a body name collide', () => {
      const spec: OpenAPIV3.Document = {
        openapi: '3.0.0',
        info: {title: 'Duplicate Parameter Names API', version: '1.0.0'},
        paths: {
          '/duplicate': {
            post: {
              operationId: 'createWithDuplicate',
              parameters: [
                {name: 'name', in: 'query', schema: {type: 'string'}},
              ],
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {name: {type: 'integer'}},
                    },
                  },
                },
              },
              responses: {'200': {description: 'OK'}},
            },
          },
        },
      };

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].name).toBe('create_with_duplicate');
      const queryParam = parsed[0].parameters.find(
        (param) => param.paramLocation === 'query',
      );
      const bodyParam = parsed[0].parameters.find(
        (param) => param.paramLocation === 'body',
      );
      expect(parsed[0].parameters.length).toBe(2);
      expect(queryParam?.name).toBe('name');
      expect(bodyParam?.originalName).toBe('name');
      expect(bodyParam?.name).not.toBe(queryParam?.name);
    });

    it('should take the base URL from the first server', () => {
      const spec = createMinimalOpenApiSpec();
      spec.servers = [
        {url: 'https://api.example.com'},
        {url: 'http://localhost:8000'},
      ];

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].endpoint.baseUrl).toBe('https://api.example.com');
    });

    it('should use the operation description', () => {
      const spec = createMinimalOpenApiSpec();
      spec.paths['/test']!.get!.description = 'This is a test description.';

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].description).toBe('This is a test description.');
    });

    it('should return an empty description for an empty description and summary', () => {
      const spec = createMinimalOpenApiSpec();
      spec.paths['/test']!.get!.description = '';
      spec.paths['/test']!.get!.summary = '';

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].description).toBe('');
    });

    it('should return an empty description when neither key is present', () => {
      const spec = createMinimalOpenApiSpec();
      delete spec.paths['/test']!.get!.summary;

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].description).toBe('');
    });

    it('should return no operations for a spec with no paths', () => {
      const spec: OpenAPIV3.Document = {
        openapi: '3.0.0',
        info: {title: 'No Paths API', version: '1.0.0'},
        paths: {},
      };

      expect(new OpenApiSpecParser().parse(spec)).toEqual([]);
    });

    it('should skip a null path item', () => {
      // A path key with nothing under it loads as null, the way `/empty:`
      // does from a YAML or JSON spec file.
      const spec = JSON.parse(
        '{"openapi":"3.0.0","info":{"title":"Empty Path Item API",' +
          '"version":"1.0.0"},"paths":{"/empty":null}}',
      ) as OpenAPIV3.Document;

      expect(new OpenApiSpecParser().parse(spec)).toEqual([]);
    });

    it('should not mutate the document it is given', () => {
      const spec = createMinimalOpenApiSpec();
      spec.paths['/no_id'] = {get: {responses: {}}};
      const before = structuredClone(spec);

      new OpenApiSpecParser().parse(spec);

      expect(spec).toEqual(before);
    });
  });

  describe('reference resolution', () => {
    it('should resolve a referenced response schema into the return value', () => {
      const spec: OpenAPIV3.Document = {
        openapi: '3.0.0',
        info: {title: 'API with Refs', version: '1.0.0'},
        paths: {
          '/test_ref': {
            get: {
              operationId: 'testGetRef',
              responses: {
                '200': {
                  description: 'Success',
                  content: {
                    'application/json': {
                      schema: {$ref: '#/components/schemas/MySchema'},
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            MySchema: {type: 'object', properties: {name: {type: 'string'}}},
          },
        },
      };

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].returnValue.paramSchema.type).toBe('object');
      expect(
        schemaProperty(parsed[0].returnValue.paramSchema, 'name').type,
      ).toBe('string');
    });

    it('should break a cycle in a referenced response schema', () => {
      const spec: OpenAPIV3.Document = {
        openapi: '3.0.0',
        info: {title: 'Circular Ref API', version: '1.0.0'},
        paths: {
          '/circular': {
            get: {
              operationId: 'getCircular',
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: {$ref: '#/components/schemas/A'},
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            A: {
              type: 'object',
              properties: {b: {$ref: '#/components/schemas/B'}},
            },
            B: {
              type: 'object',
              properties: {a: {$ref: '#/components/schemas/A'}},
            },
          },
        },
      };

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed.length).toBe(1);
      const schemaA = parsed[0].returnValue.paramSchema;
      expect(schemaA.type).toBe('object');
      const innerA = schemaProperty(schemaProperty(schemaA, 'b'), 'a');
      expect(innerA).toEqual({});
    });

    it('should resolve references three levels deep across several paths', () => {
      const spec: OpenAPIV3.Document = {
        openapi: '3.0.0',
        info: {title: 'Multiple Paths Deep Refs API', version: '1.0.0'},
        paths: {
          '/path1': {
            post: {
              operationId: 'postPath1',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {$ref: '#/components/schemas/Request1'},
                  },
                },
              },
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: {$ref: '#/components/schemas/Response1'},
                    },
                  },
                },
              },
            },
          },
          '/path2': {
            put: {
              operationId: 'putPath2',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {$ref: '#/components/schemas/Request2'},
                  },
                },
              },
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: {$ref: '#/components/schemas/Response2'},
                    },
                  },
                },
              },
            },
            get: {
              operationId: 'getPath2',
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: {$ref: '#/components/schemas/Response2'},
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Request1: {
              type: 'object',
              properties: {
                req1_prop1: {$ref: '#/components/schemas/Level1_1'},
              },
            },
            Response1: {
              type: 'object',
              properties: {
                res1_prop1: {$ref: '#/components/schemas/Level1_2'},
              },
            },
            Request2: {
              type: 'object',
              properties: {
                req2_prop1: {$ref: '#/components/schemas/Level1_1'},
              },
            },
            Response2: {
              type: 'object',
              properties: {
                res2_prop1: {$ref: '#/components/schemas/Level1_2'},
              },
            },
            Level1_1: {
              type: 'object',
              properties: {
                level1_1_prop1: {$ref: '#/components/schemas/Level2_1'},
              },
            },
            Level1_2: {
              type: 'object',
              properties: {
                level1_2_prop1: {$ref: '#/components/schemas/Level2_2'},
              },
            },
            Level2_1: {
              type: 'object',
              properties: {
                level2_1_prop1: {$ref: '#/components/schemas/Level3'},
              },
            },
            Level2_2: {
              type: 'object',
              properties: {level2_2_prop1: {type: 'string'}},
            },
            Level3: {type: 'integer'},
          },
        },
      };

      const parsed = new OpenApiSpecParser().parse(spec);

      // Paths keep document order; methods follow the fixed method order, so
      // `get` on /path2 comes before the `put` declared above it.
      expect(parsed.map((op) => op.name)).toEqual([
        'post_path1',
        'get_path2',
        'put_path2',
      ]);

      const path1Op = parsed[0];
      expect(path1Op.parameters.length).toBe(1);
      expect(path1Op.parameters[0].originalName).toBe('req1_prop1');
      expect(
        schemaProperty(
          schemaProperty(path1Op.parameters[0].paramSchema, 'level1_1_prop1'),
          'level2_1_prop1',
        ).type,
      ).toBe('integer');
      expect(
        schemaProperty(
          schemaProperty(
            schemaProperty(path1Op.returnValue.paramSchema, 'res1_prop1'),
            'level1_2_prop1',
          ),
          'level2_2_prop1',
        ).type,
      ).toBe('string');

      const path2Op = parsed[2];
      expect(path2Op.parameters[0].originalName).toBe('req2_prop1');
      expect(
        schemaProperty(
          schemaProperty(path2Op.parameters[0].paramSchema, 'level1_1_prop1'),
          'level2_1_prop1',
        ).type,
      ).toBe('integer');
      expect(
        schemaProperty(
          schemaProperty(
            schemaProperty(path2Op.returnValue.paramSchema, 'res2_prop1'),
            'level1_2_prop1',
          ),
          'level2_2_prop1',
        ).type,
      ).toBe('string');
    });

    it('should give two operations that share a reference their own schema', () => {
      const spec: OpenAPIV3.Document = {
        openapi: '3.0.0',
        info: {title: 'Shared Ref API', version: '1.0.0'},
        paths: {
          '/first': {
            get: {
              operationId: 'getFirst',
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: {$ref: '#/components/schemas/Shared'},
                    },
                  },
                },
              },
            },
          },
          '/second': {
            get: {
              operationId: 'getSecond',
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: {$ref: '#/components/schemas/Shared'},
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Shared: {type: 'object', properties: {name: {type: 'string'}}},
          },
        },
      };

      const parsed = new OpenApiSpecParser().parse(spec);
      const [first, second] = parsed;

      // OpenAPIToolset builds one tool per operation, so a shared schema
      // object would let one tool see another tool's mutation.
      expect(first.returnValue.paramSchema).not.toBe(
        second.returnValue.paramSchema,
      );
      schemaProperty(first.returnValue.paramSchema, 'name').type = 'integer';
      expect(schemaProperty(second.returnValue.paramSchema, 'name').type).toBe(
        'string',
      );
    });
  });

  describe('auth scheme resolution', () => {
    const apiKeyScheme: OpenAPIV3.SecuritySchemeObject = {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    };

    /** Builds a spec whose global and operation security the test chooses. */
    function createSecuredSpec(
      globalSecurity?: OpenAPIV3.SecurityRequirementObject[],
      operationSecurity?: OpenAPIV3.SecurityRequirementObject[],
    ): OpenAPIV3.Document {
      const spec = createMinimalOpenApiSpec();
      if (globalSecurity) {
        spec.security = globalSecurity;
      }
      if (operationSecurity) {
        spec.paths['/test']!.get!.security = operationSecurity;
      }
      spec.components = {securitySchemes: {api_key: apiKeyScheme}};
      return spec;
    }

    it('should resolve the global scheme for an operation that declares none', () => {
      const parsed = new OpenApiSpecParser().parse(
        createSecuredSpec([{api_key: []}]),
      );

      expect(parsed[0].authScheme?.type).toBe('apiKey');
    });

    it('should resolve an operation-level scheme', () => {
      const spec = createMinimalOpenApiSpec();
      spec.paths['/test']!.get!.security = [{local_auth: []}];
      spec.components = {
        securitySchemes: {local_auth: {type: 'http', scheme: 'bearer'}},
      };

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].authScheme?.type).toBe('http');
      expect(parsed[0].authScheme).toEqual({type: 'http', scheme: 'bearer'});
    });

    it('should let an empty operation security list opt out of the global scheme', () => {
      const spec = createSecuredSpec([{api_key: []}], []);
      spec.paths['/test']!.post = {
        operationId: 'testPost',
        responses: {'200': {description: 'OK'}},
      };

      const parsed = new OpenApiSpecParser().parse(spec);

      const getOp = parsed.find((op) => op.endpoint.method === 'get');
      const postOp = parsed.find((op) => op.endpoint.method === 'post');
      expect(getOp?.authScheme).toBeUndefined();
      expect(postOp?.authScheme?.type).toBe('apiKey');
    });

    it('should treat an empty global requirement object as optional auth', () => {
      const parsed = new OpenApiSpecParser().parse(
        createSecuredSpec([{api_key: []}, {}]),
      );

      expect(parsed[0].authScheme).toBeUndefined();
    });

    it('should treat an empty operation requirement object as optional auth', () => {
      const parsed = new OpenApiSpecParser().parse(
        createSecuredSpec(undefined, [{api_key: []}, {}]),
      );

      expect(parsed[0].authScheme).toBeUndefined();
    });

    it('should keep the scheme type while sanitizing an invalid schema type', () => {
      // `type: "Any"` is not a JSON Schema type, so the parser drops it. The
      // securitySchemes `type` names a scheme kind and must survive.
      const spec = JSON.parse(
        '{"openapi":"3.0.0","info":{"title":"Sanitize Security API",' +
          '"version":"1.0.0"},"security":[{"api_key":[]}],' +
          '"paths":{"/test":{"get":{"operationId":"testGet","responses":' +
          '{"200":{"description":"OK","content":{"application/json":' +
          '{"schema":{"$ref":"#/components/schemas/Invalid"}}}}}}}},' +
          '"components":{"schemas":{"Invalid":{"type":"Any"}},' +
          '"securitySchemes":{"api_key":{"type":"apiKey","in":"header",' +
          '"name":"X-API-Key"}}}}',
      ) as OpenAPIV3.Document;

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].authScheme?.type).toBe('apiKey');
      expect(parsed[0].returnValue.paramSchema.type).toBeUndefined();
    });

    it('should resolve no scheme when the named scheme is not declared', () => {
      const spec = createMinimalOpenApiSpec();
      spec.security = [{missing_scheme: []}];

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].authScheme).toBeUndefined();
    });
  });

  describe('input validation', () => {
    it.each([
      ['a number', 123],
      ['a string', 'openapi_spec'],
      ['an array', []],
      ['null', null],
    ])('should reject %s', (_label, value) => {
      expect(() => parseUntyped(value)).toThrow(TypeError);
      expect(() => parseUntyped(value)).toThrow(
        'OpenAPI spec must be an object.',
      );
    });
  });
});
