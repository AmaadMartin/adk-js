/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenApiSpecParser, ParsedOperation} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

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
            // operationId is missing, so it is synthesized from path + method.
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
    it('should take the return value from the 2xx response', () => {
      const parsed = new OpenApiSpecParser().parse(minimalSpec());

      expect(parsed.length).toBe(1);
      expect(parsed[0].returnValue).toEqual({
        originalName: '',
        paramLocation: '',
        paramSchema: {type: 'string'},
        required: true,
        name: 'return',
      });
    });

    it('should take the return value from the lowest 2xx response', () => {
      const spec = minimalSpec();
      responseContent(spec, '202', {type: 'boolean'});

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].returnValue?.paramSchema.type).toBe('string');
    });

    it('should return an empty schema when no response is 2xx', () => {
      const spec = minimalSpec();
      spec.paths['/test']!.get!.responses = {'404': {description: 'Missing'}};

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].returnValue?.paramSchema).toEqual({});
    });

    it('should resolve a referenced response schema into the return value', () => {
      const spec = minimalSpec();
      responseContent(spec, '200', {$ref: '#/components/schemas/User'});
      spec.components = {
        schemas: {User: {type: 'object', properties: {name: {type: 'string'}}}},
      };

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].returnValue?.paramSchema.properties?.name).toEqual({
        type: 'string',
      });
    });

    it('should seed additionalContext empty', () => {
      const parsed = new OpenApiSpecParser().parse(minimalSpec());

      expect(parsed[0].additionalContext).toEqual({});
    });

    it('should give each operation its own additionalContext', () => {
      const spec = minimalSpec();
      spec.paths['/other'] = {get: {responses: {}}};

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed.length).toBe(2);
      expect(parsed[0].additionalContext).not.toBe(parsed[1].additionalContext);
    });

    it.each([
      ['/pets/{petId}', 'get', 'pets_pet_id_get'],
      [
        '/Orders/{orderId}/lineItems',
        'patch',
        'orders_order_id_line_items_patch',
      ],
      ['/v1/REST API/items', 'post', 'v1_rest_api_items_post'],
    ])('should name %s %s as adk-python does', (path, method, expectedName) => {
      const spec: OpenAPIV3.Document = {
        openapi: '3.0.0',
        info: {title: 'Naming API', version: '1.0.0'},
        paths: {[path]: {[method]: {responses: {}}}},
      };

      const parsed = new OpenApiSpecParser().parse(spec);

      expect(parsed[0].operation.operationId).toBe(expectedName);
      expect(parsed[0].name).toBe(expectedName);
    });
  });

  describe('shared references', () => {
    it('should give each use of a reference its own subtree', () => {
      const parsed = new OpenApiSpecParser().parse(sharedRefSpec());

      const schemas = SHARED_REF_PATHS.map((path) =>
        requestSchema(parsed, path),
      );

      expect(new Set(schemas).size).toBe(SHARED_REF_PATHS.length);
      expect(schemas[1]).toEqual(schemas[0]);
      expect(schemas[2]).toEqual(schemas[0]);
    });

    it('should keep an edit to one use out of the others', () => {
      const parsed = new OpenApiSpecParser().parse(sharedRefSpec());

      requestSchema(parsed, '/a').properties!.name = {type: 'integer'};

      expect(requestSchema(parsed, '/b').properties?.name).toEqual({
        type: 'string',
      });
      expect(requestSchema(parsed, '/c').properties?.name).toEqual({
        type: 'string',
      });
    });

    it('should leave the caller’s document unchanged', () => {
      const spec = sharedRefSpec();

      new OpenApiSpecParser().parse(spec);

      expect(spec).toEqual(sharedRefSpec());
    });
  });
});

/**
 * Mirrors the minimal fixture of adk-python's spec parser tests: one `get` on
 * `/test` that returns a string.
 */
function minimalSpec(): OpenAPIV3.Document {
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

/** Sets the JSON response schema of `minimalSpec`'s operation. */
function responseContent(
  spec: OpenAPIV3.Document,
  code: string,
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
) {
  spec.paths['/test']!.get!.responses[code] = {
    description: 'Response',
    content: {'application/json': {schema}},
  };
}

const SHARED_REF_PATHS = ['/a', '/b', '/c'];

/**
 * A spec whose paths all reference one schema. Three uses, not two: with two,
 * dropping the copy still leaves the first use holding the cache entry and the
 * second holding the copy, so the two stay distinct.
 */
function sharedRefSpec(): OpenAPIV3.Document {
  const operation: OpenAPIV3.OperationObject = {
    requestBody: {
      content: {
        'application/json': {schema: {$ref: '#/components/schemas/Shared'}},
      },
    },
    responses: {},
  };
  return {
    openapi: '3.0.0',
    info: {title: 'Shared Ref API', version: '1.0.0'},
    paths: Object.fromEntries(
      SHARED_REF_PATHS.map((path) => [
        path,
        {post: structuredClone(operation)},
      ]),
    ),
    components: {
      schemas: {Shared: {type: 'object', properties: {name: {type: 'string'}}}},
    },
  };
}

/** Reads a resolved request body schema, failing the test if it is missing. */
function requestSchema(
  parsed: ParsedOperation[],
  path: string,
): OpenAPIV3.SchemaObject {
  const operation = parsed.find((op) => op.endpoint.path === path)?.operation;
  const requestBody = operation?.requestBody;
  if (!requestBody || '$ref' in requestBody) {
    expect.fail(`no resolved request body on ${path}`);
  }
  const schema = requestBody.content['application/json'].schema;
  if (!schema || '$ref' in schema) {
    expect.fail(`no resolved request body schema on ${path}`);
  }
  return schema;
}
