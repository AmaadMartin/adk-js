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
    expect(params[0].name).toBe('body');
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
      "response '200' body contains unresolved reference" +
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

  it('should be unknown when the operation was not parsed', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {
        '200': {
          description: 'OK',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      },
    };

    const parser = new OperationParser(op, {shouldParse: false});

    expect(parser.getReturnTypeHint()).toBe('unknown');
  });
});

describe('OperationParser construction', () => {
  const op: OpenAPIV3.OperationObject = {
    operationId: 'getPet',
    parameters: [{name: 'petId', in: 'path', schema: {type: 'integer'}}],
    responses: {},
  };

  it('should skip parsing when shouldParse is false', () => {
    const parser = new OperationParser(op, {shouldParse: false});

    expect(parser.getParameters()).toEqual([]);
    expect(parser.getJsonSchema().properties).toEqual({});
  });

  it('should parse an operation supplied as a JSON string', () => {
    const parser = new OperationParser(JSON.stringify(op));

    expect(parser.getFunctionName()).toBe('get_pet');
    expect(parser.getParameters()[0].name).toBe('pet_id');
  });

  it('should not read a schema the operation cannot resolve', () => {
    const unresolved: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [
        {name: 'petId', in: 'path', schema: {$ref: '#/components/schemas/Id'}},
      ],
      responses: {},
    };

    expect(() => new OperationParser(unresolved)).toThrow(
      'unresolved reference',
    );
    expect(
      () => new OperationParser(unresolved, {shouldParse: false}),
    ).not.toThrow();
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

describe('OperationParser.load', () => {
  const op: OpenAPIV3.OperationObject = {
    operationId: 'getPet',
    summary: 'Get a pet',
    parameters: [{name: 'petId', in: 'path', schema: {type: 'integer'}}],
    responses: {},
  };

  const petId: ApiParameter = {
    originalName: 'petId',
    paramLocation: 'path',
    paramSchema: {type: 'string', description: 'The pet id'},
    description: 'The pet id',
    name: 'pet_id',
    required: true,
  };

  it('should report the supplied parameters instead of parsing', () => {
    const parser = OperationParser.load(op, [petId]);

    expect(parser.getParameters()).toEqual([petId]);
    expect(parser.getJsonSchema()).toEqual({
      type: 'object',
      properties: {pet_id: {type: 'string', description: 'The pet id'}},
      required: ['pet_id'],
      title: 'getPet_Arguments',
    });
  });

  it('should report the supplied return value', () => {
    const returnValue: ApiParameter = {
      originalName: '',
      paramLocation: '',
      paramSchema: {type: 'boolean'},
      name: 'value',
      required: false,
    };

    const parser = OperationParser.load(op, [], returnValue);

    expect(parser.getReturnTypeHint()).toBe('boolean');
  });

  it('should not re-read an operation whose schema is unresolved', () => {
    const unresolved: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [
        {name: 'petId', in: 'path', schema: {$ref: '#/components/schemas/Id'}},
      ],
      responses: {},
    };

    const parser = OperationParser.load(unresolved, [petId]);

    expect(parser.getParameters()).toEqual([petId]);
  });

  it('should still read the function name from the operation', () => {
    expect(OperationParser.load(op, []).getFunctionName()).toBe('get_pet');
  });

  it('should document the supplied parameters', () => {
    const docString = OperationParser.load(op, [petId]).getDocString();

    expect(docString).toBe(
      'Get a pet\n\nArgs:\n    pet_id (string): The pet id\n\n',
    );
  });

  it('should accept an operation supplied as a JSON string', () => {
    const parser = OperationParser.load(JSON.stringify(op), [petId]);

    expect(parser.getFunctionName()).toBe('get_pet');
    expect(parser.getParameters()).toEqual([petId]);
  });

  it('should keep the supplied names when preserving property names', () => {
    const parser = OperationParser.load(op, [petId], undefined, {
      preservePropertyNames: true,
    });

    expect(parser.getParameters()[0].name).toBe('pet_id');
  });
});
