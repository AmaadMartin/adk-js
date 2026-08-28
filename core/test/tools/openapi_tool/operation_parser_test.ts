/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ApiParameter, OperationParser} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

describe('OperationParser', () => {
  it('should throw error if operationId is missing', () => {
    const op: OpenAPIV3.OperationObject = {
      responses: {},
    };
    const parser = new OperationParser(op);
    expect(() => parser.getFunctionName()).toThrow('Operation ID is missing');
  });

  it('should parse array request body', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: {type: 'string'},
            },
          },
        },
      },
      responses: {},
    };

    const parser = new OperationParser(op);
    const params = parser.getParameters();

    expect(params.length).toBe(1);
    expect(params[0].name).toBe('array');
    expect(params[0].paramLocation).toBe('body');
    expect(params[0].paramSchema.type).toBe('array');
  });

  it('should parse primitive request body', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'string',
            },
          },
        },
      },
      responses: {},
    };

    const parser = new OperationParser(op);
    const params = parser.getParameters();

    expect(params.length).toBe(1);
    expect(params[0].name).toBe('body');
    expect(params[0].paramLocation).toBe('body');
    expect(params[0].paramSchema.type).toBe('string');
  });

  it('should parse response schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  id: {type: 'integer'},
                },
              },
            },
          },
        },
      },
    };

    const parser = new OperationParser(op);
    const schema = parser.getJsonSchema();

    expect(schema).toBeTruthy();
    expect(schema.title).toBe('testOp_Arguments');
  });
});

describe('OperationParser schema normalization', () => {
  it('should reject a parameter schema that is an unresolved reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [
        {name: 'petId', in: 'path', schema: {$ref: '#/components/schemas/Id'}},
      ],
      responses: {},
    };

    expect(() => new OperationParser(op)).toThrow(
      "operation parameter 'petId' contains unresolved reference" +
        " '#/components/schemas/Id'",
    );
  });

  it('should reject a body property that is an unresolved reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'createPet',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {pet: {$ref: '#/components/schemas/Pet'}},
            },
          },
        },
      },
      responses: {},
    };

    expect(() => new OperationParser(op)).toThrow(
      "request body property 'pet' contains unresolved reference" +
        " '#/components/schemas/Pet'",
    );
  });

  it('should reject a response schema that is an unresolved reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': {schema: {$ref: '#/components/schemas/Pet'}},
          },
        },
      },
    };

    expect(() => new OperationParser(op)).toThrow(
      "response media type 'application/json' contains unresolved reference" +
        " '#/components/schemas/Pet'",
    );
  });

  it('should skip a parameter that is itself a reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listPets',
      parameters: [
        {$ref: '#/components/parameters/Missing'},
        {name: 'limit', in: 'query', schema: {type: 'integer'}},
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params.length).toBe(1);
    expect(params[0].name).toBe('limit');
  });

  it('should take the parameter description from its schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listPets',
      parameters: [
        {
          name: 'limit',
          in: 'query',
          schema: {type: 'integer', description: 'How many pets'},
        },
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params[0].description).toBe('How many pets');
  });

  it('should name an unnamed parameter after its location', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listPets',
      parameters: [{name: '', in: 'query', schema: {type: 'string'}}],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params[0].name).toBe('query_param');
  });
});

describe('OperationParser.getDocString', () => {
  it('should render the summary, the arguments and the return value', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      summary: 'Get a pet by id',
      parameters: [
        {
          name: 'petId',
          in: 'path',
          description: 'The pet id',
          required: true,
          schema: {type: 'integer'},
        },
      ],
      responses: {
        '200': {
          description: 'The pet name',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      },
    };

    const docString = new OperationParser(op).getDocString();

    expect(docString).toContain('Get a pet by id');
    expect(docString).toContain('Args:');
    expect(docString).toContain('    pet_id (number): The pet id');
    expect(docString).toContain('Returns (string): The pet name');
  });

  it('should fall back to the description when there is no summary', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      description: 'Fetches one pet',
      responses: {},
    };

    expect(new OperationParser(op).getDocString()).toContain('Fetches one pet');
  });

  it('should prefer the summary over the description', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      summary: 'Get a pet',
      description: 'Fetches one pet',
      responses: {},
    };

    expect(new OperationParser(op).getDocString()).toBe(
      'Get a pet\n\nArgs:\n\n\n',
    );
  });

  it('should render an operation with no summary and no arguments', () => {
    const op: OpenAPIV3.OperationObject = {operationId: 'ping', responses: {}};

    expect(new OperationParser(op).getDocString()).toBe('\n\nArgs:\n\n\n');
  });

  it('should render one line per argument', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listPets',
      parameters: [
        {name: 'limit', in: 'query', schema: {type: 'integer'}},
        {name: 'tag', in: 'query', schema: {type: 'string'}},
      ],
      responses: {},
    };

    expect(new OperationParser(op).getDocString()).toContain(
      '    limit (number): \n    tag (string): ',
    );
  });

  it('should render an operation that declares no responses', () => {
    const parser = new OperationParser(
      '{"operationId":"ping","summary":"Ping"}',
    );

    expect(parser.getDocString()).toBe('Ping\n\nArgs:\n\n\n');
  });
});

describe('OperationParser.getAuthSchemeName', () => {
  it('should return the scheme the operation requires', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      security: [{oauth2: ['read']}],
      responses: {},
    };

    expect(new OperationParser(op).getAuthSchemeName()).toBe('oauth2');
  });

  it('should take the first of several requirements', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      security: [{apiKey: []}, {oauth2: ['read']}],
      responses: {},
    };

    expect(new OperationParser(op).getAuthSchemeName()).toBe('apiKey');
  });

  it('should take the first key of a requirement naming two schemes', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      security: [{apiKey: [], oauth2: ['read']}],
      responses: {},
    };

    expect(new OperationParser(op).getAuthSchemeName()).toBe('apiKey');
  });

  it('should return nothing when the operation declares no security', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {},
    };

    expect(new OperationParser(op).getAuthSchemeName()).toBe('');
  });

  it('should return nothing for an empty security list', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      security: [],
      responses: {},
    };

    expect(new OperationParser(op).getAuthSchemeName()).toBe('');
  });

  it('should return nothing for a requirement that names no scheme', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      security: [{}],
      responses: {},
    };

    expect(new OperationParser(op).getAuthSchemeName()).toBe('');
  });
});

describe('OperationParser.getReturnTypeHint', () => {
  it('should read the type of the 2xx response schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {
        '200': {
          description: 'OK',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      },
    };

    expect(new OperationParser(op).getReturnTypeHint()).toBe('string');
  });

  it('should read an array response as an array type', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listPets',
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': {
              schema: {type: 'array', items: {type: 'string'}},
            },
          },
        },
      },
    };

    expect(new OperationParser(op).getReturnTypeHint()).toBe('string[]');
  });

  it('should be unknown when no 2xx response declares a schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'deletePet',
      responses: {'204': {description: 'No content'}},
    };

    expect(new OperationParser(op).getReturnTypeHint()).toBe('unknown');
  });
});

describe('OperationParser construction', () => {
  const op: OpenAPIV3.OperationObject = {
    operationId: 'getPet',
    parameters: [{name: 'petId', in: 'path', schema: {type: 'integer'}}],
    responses: {},
  };

  it('should parse an operation supplied as a JSON string', () => {
    const parser = new OperationParser(JSON.stringify(op));

    expect(parser.getFunctionName()).toBe('get_pet');
    expect(parser.getParameters()[0].name).toBe('pet_id');
  });

  it('should reject a JSON string that is not an object', () => {
    expect(() => new OperationParser('[]')).toThrow(
      'Operation must be a JSON object',
    );
    expect(() => new OperationParser('"getPet"')).toThrow(
      'Operation must be a JSON object',
    );
    expect(() => new OperationParser('null')).toThrow(
      'Operation must be a JSON object',
    );
  });
});

describe('OperationParser request body parity', () => {
  function bodyParams(schema: OpenAPIV3.SchemaObject): ApiParameter[] {
    return new OperationParser({
      operationId: 'testOp',
      requestBody: {content: {'application/json': {schema}}},
      responses: {},
    }).getParameters();
  }

  it('should emit no parameter for an object body with no properties', () => {
    expect(bodyParams({type: 'object'})).toEqual([]);
    expect(bodyParams({type: 'object', properties: {}})).toEqual([]);
  });

  it('should leave a scalar body an empty original name', () => {
    const params = bodyParams({type: 'string'});

    expect(params.length).toBe(1);
    expect(params[0].originalName).toBe('');
    expect(params[0].name).toBe('body');
  });

  it('should name a oneOf body body', () => {
    const params = bodyParams({oneOf: [{type: 'string'}, {type: 'integer'}]});

    expect(params[0].originalName).toBe('body');
    expect(params[0].name).toBe('body');
  });

  it('should name an anyOf body body', () => {
    expect(bodyParams({anyOf: [{type: 'string'}]})[0].originalName).toBe(
      'body',
    );
  });

  it('should name an allOf body body', () => {
    expect(bodyParams({allOf: [{type: 'object'}]})[0].originalName).toBe(
      'body',
    );
  });

  it('should name a typeless body body', () => {
    expect(bodyParams({})[0].originalName).toBe('body');
  });

  it('should name an array body array', () => {
    const params = bodyParams({type: 'array', items: {type: 'string'}});

    expect(params[0].originalName).toBe('array');
    expect(params[0].name).toBe('array');
  });

  it('should not require a body the schema does not mark required', () => {
    for (const schema of [
      {type: 'string'} as OpenAPIV3.SchemaObject,
      {type: 'array', items: {type: 'string'}} as OpenAPIV3.SchemaObject,
      {oneOf: [{type: 'string'}]} as OpenAPIV3.SchemaObject,
    ]) {
      expect(bodyParams(schema)[0].required).toBe(false);
    }
  });

  it('should require only the properties the object body lists', () => {
    const params = bodyParams({
      type: 'object',
      properties: {spaceName: {type: 'string'}, note: {type: 'string'}},
      required: ['spaceName'],
    });

    expect(params.map((param) => [param.name, param.required])).toEqual([
      ['space_name', true],
      ['note', false],
    ]);
  });

  it('should list a required body property in the argument schema', () => {
    const parser = new OperationParser({
      operationId: 'testOp',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {spaceName: {type: 'string'}, note: {type: 'string'}},
              required: ['spaceName'],
            },
          },
        },
      },
      responses: {},
    });

    expect(parser.getJsonSchema().required).toEqual(['space_name']);
  });

  it('should keep an empty name out of the argument schema', () => {
    const parser = new OperationParser({
      operationId: 'testOp',
      requestBody: {content: {'application/json': {schema: {type: 'string'}}}},
      responses: {},
    });

    expect(Object.keys(parser.getJsonSchema().properties ?? {})).toEqual([
      'body',
    ]);
  });

  it('should emit no parameter for a body with an empty content map', () => {
    const parser = new OperationParser({
      operationId: 'testOp',
      requestBody: {content: {}},
      responses: {},
    });

    expect(parser.getParameters()).toEqual([]);
  });

  it('should emit no parameter for a body that declares no content', () => {
    const parser = new OperationParser(
      '{"operationId":"testOp","requestBody":{},"responses":{}}',
    );

    expect(parser.getParameters()).toEqual([]);
  });

  it('should reject a request body that is an unresolved reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {$ref: '#/components/requestBodies/Pet'},
      responses: {},
    };

    expect(() => new OperationParser(op)).toThrow(
      "Request body contains unresolved reference '#/components/requestBodies/Pet'",
    );
  });

  it('should reject a request body media type schema that is a reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {
        content: {
          'application/json': {schema: {$ref: '#/components/schemas/Pet'}},
        },
      },
      responses: {},
    };

    expect(() => new OperationParser(op)).toThrow(
      "request body media type 'application/json' contains unresolved" +
        " reference '#/components/schemas/Pet'",
    );
  });
});

describe('OperationParser.getReturnValue', () => {
  it('should name the return value after its empty location', () => {
    const parser = new OperationParser({
      operationId: 'getPet',
      responses: {
        '200': {
          description: 'OK',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      },
    });

    expect(parser.getReturnValue()).toEqual({
      originalName: '',
      paramLocation: '',
      paramSchema: {type: 'string'},
      description: '',
      name: 'value',
      required: false,
    });
  });

  it('should take the smallest 2xx response', () => {
    const parser = new OperationParser({
      operationId: 'getPet',
      responses: {
        '202': {
          description: 'Accepted',
          content: {'application/json': {schema: {type: 'string'}}},
        },
        '200': {
          description: 'OK',
          content: {'application/json': {schema: {type: 'boolean'}}},
        },
        '201': {
          description: 'Created',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
      },
    });

    expect(parser.getReturnTypeHint()).toBe('boolean');
  });

  it('should skip a media type that declares no schema', () => {
    const parser = new OperationParser({
      operationId: 'getPet',
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/xml': {},
            'application/json': {schema: {type: 'integer'}},
          },
        },
      },
    });

    expect(parser.getReturnTypeHint()).toBe('number');
  });

  it('should be unknown for a 2xx response with an empty content map', () => {
    const parser = new OperationParser({
      operationId: 'getPet',
      responses: {'200': {description: 'OK', content: {}}},
    });

    expect(parser.getReturnTypeHint()).toBe('unknown');
  });

  it('should document the response it also reports', () => {
    const parser = new OperationParser({
      operationId: 'getPet',
      responses: {
        '200': {description: 'No content'},
        '201': {
          description: 'Created',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      },
    });

    expect(parser.getReturnTypeHint()).toBe('string');
    expect(parser.getDocString()).toContain('Returns (string): Created');
  });

  it('should reject a response that is an unresolved reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {'200': {$ref: '#/components/responses/Ok'}},
    };

    expect(() => new OperationParser(op)).toThrow(
      "Response contains unresolved reference '#/components/responses/Ok'",
    );
  });
});

describe('OperationParser duplicate argument names', () => {
  it('should number the duplicates from zero', () => {
    const parser = new OperationParser({
      operationId: 'testOp',
      parameters: [
        {name: 'test', in: 'query', schema: {type: 'string'}},
        {name: 'test', in: 'header', schema: {type: 'string'}},
        {name: 'test', in: 'path', schema: {type: 'string'}},
      ],
      responses: {},
    });

    expect(parser.getParameters().map((param) => param.name)).toEqual([
      'test',
      'test_0',
      'test_1',
    ]);
  });

  it('should leave a name that occurs once alone', () => {
    const parser = new OperationParser({
      operationId: 'testOp',
      parameters: [
        {name: 'first', in: 'query', schema: {type: 'string'}},
        {name: 'second', in: 'query', schema: {type: 'string'}},
      ],
      responses: {},
    });

    expect(parser.getParameters().map((param) => param.name)).toEqual([
      'first',
      'second',
    ]);
  });
});

describe('OperationParser.getFunctionName parity', () => {
  function functionName(
    operationId: string,
    preservePropertyNames = false,
  ): string {
    return new OperationParser(
      {operationId, responses: {}},
      {preservePropertyNames},
    ).getFunctionName();
  }

  it('should split an acronym', () => {
    expect(functionName('getHTTPResponse')).toBe('get_http_response');
  });

  it('should snake_case regardless of preservePropertyNames', () => {
    expect(functionName('getHTTPResponse', true)).toBe('get_http_response');
  });

  it('should keep the spec argument name when preserving property names', () => {
    const parser = new OperationParser(
      {
        operationId: 'getPet',
        parameters: [{name: 'petId', in: 'path', schema: {type: 'integer'}}],
        responses: {},
      },
      {preservePropertyNames: true},
    );

    expect(parser.getParameters()[0].name).toBe('petId');
    expect(parser.getFunctionName()).toBe('get_pet');
  });

  it('should truncate a long name to 60 characters', () => {
    expect(functionName('a'.repeat(80))).toBe('a'.repeat(60));
  });
});

describe('OperationParser optional authentication', () => {
  function schemeName(security: Array<Record<string, string[]>>): string {
    return new OperationParser({
      operationId: 'getPet',
      security,
      responses: {},
    }).getAuthSchemeName();
  }

  it('should require no scheme when a later requirement is empty', () => {
    expect(schemeName([{apiKey: []}, {}])).toBe('');
  });

  it('should require no scheme when an earlier requirement is empty', () => {
    expect(schemeName([{}, {apiKey: []}])).toBe('');
  });

  it('should keep the scheme when every requirement names one', () => {
    expect(schemeName([{apiKey: []}, {oauth2: ['read']}])).toBe('apiKey');
  });
});
