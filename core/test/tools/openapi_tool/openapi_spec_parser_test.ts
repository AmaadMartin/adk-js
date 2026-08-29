/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenApiSpecParser} from '@google/adk';
import * as fs from 'fs';
import yaml from 'js-yaml';
import {OpenAPIV3} from 'openapi-types';
import * as path from 'path';
import {beforeAll, describe, expect, it} from 'vitest';

describe('OpenApiSpecParser', () => {
  it('should keep every operation when one reference stays unresolved', () => {
    const spec: OpenAPIV3.Document = {
      openapi: '3.0.0',
      info: {title: 'Test API', version: '1.0.0'},
      paths: {
        '/broken': {
          post: {
            operationId: 'createPet',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      owner: {$ref: '#/components/schemas/Missing'},
                      name: {type: 'string'},
                    },
                  },
                },
              },
            },
            responses: {},
          },
        },
        '/healthy': {
          get: {
            operationId: 'listPets',
            parameters: [
              {name: 'limit', in: 'query', schema: {type: 'integer'}},
            ],
            responses: {},
          },
        },
      },
    };

    const operations = new OpenApiSpecParser().parse(spec);

    expect(operations.map((operation) => operation.name)).toEqual([
      'create_pet',
      'list_pets',
    ]);
    expect(operations[0].parameters.map((param) => param.name)).toEqual([
      'name',
    ]);
  });

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
            // operationId is missing, should be auto-generated as "get__users__id_"
            responses: {},
          },
        },
      },
    };

    const parser = new OpenApiSpecParser();
    const parsed = parser.parse(spec);

    expect(parsed.length).toBe(1);
    const op = parsed[0];
    expect(op.name).toBe('get__users__id_');
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
});

describe('OpenApiSpecParser with the petstore fixture', () => {
  let petstore: OpenAPIV3.Document;

  beforeAll(() => {
    const specPath = path.resolve(__dirname, 'fixtures/petstore.yaml');
    petstore = yaml.load(
      fs.readFileSync(specPath, 'utf8'),
    ) as OpenAPIV3.Document;
  });

  it('should build every parameter of every operation as an ApiParameter', () => {
    const operations = new OpenApiSpecParser().parse(petstore);

    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) {
      for (const param of operation.parameters) {
        expect(param.typeHint).not.toBe('');
        expect(param.typeValue.kind).not.toBe('');
        expect(param.name).not.toBe('');
      }
    }
  });

  it('should type a parameter parsed off the fixture', () => {
    const operations = new OpenApiSpecParser().parse(petstore);
    const findByStatus = operations.find(
      (operation) => operation.name === 'find_pets_by_status',
    );
    if (!findByStatus) {
      expect.fail('the fixture should declare findPetsByStatus');
    }

    const status = findByStatus.parameters[0];

    expect(status.name).toBe('status');
    expect(status.typeHint).toBe('string');
    expect(status.typeValue).toEqual({kind: 'string'});
    expect(status.description).toBe(
      'Status values that need to be considered for filter',
    );
  });

  it('should type an array-of-object body parameter off the fixture', () => {
    const operations = new OpenApiSpecParser().parse(petstore);
    const createUsers = operations.find(
      (operation) => operation.name === 'create_users_with_list_input',
    );
    if (!createUsers) {
      expect.fail('the fixture should declare createUsersWithListInput');
    }

    const body = createUsers.parameters[0];

    expect(body.name).toBe('body');
    expect(body.typeHint).toBe('Array<Record<string, unknown>>');
    expect(body.typeValue).toEqual({kind: 'array', items: {kind: 'object'}});
  });
});
