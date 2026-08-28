/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApiParameter,
  createApiParameter,
  generateParamDoc,
  generateReturnDoc,
  getTypeHint,
  normalizeSchema,
  toSnakeCaseName,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

describe('normalizeSchema', () => {
  it('should return an empty schema for a missing schema', () => {
    expect(normalizeSchema(undefined, 'response body')).toEqual({});
    expect(normalizeSchema(null, 'response body')).toEqual({});
  });

  it('should return an empty schema for the true schema', () => {
    expect(normalizeSchema(true, 'response body')).toEqual({});
  });

  it('should reject the false schema', () => {
    expect(() => normalizeSchema(false, "parameter 'petId'")).toThrow(
      "parameter 'petId' uses an unsatisfiable false schema",
    );
  });

  it('should reject an unresolved reference', () => {
    expect(() =>
      normalizeSchema({$ref: '#/components/schemas/Pet'}, 'response body'),
    ).toThrow(
      "response body contains unresolved reference '#/components/schemas/Pet'",
    );
  });

  it('should reject a value that cannot be a schema', () => {
    expect(() => normalizeSchema(42, 'response body')).toThrow(
      'response body must be an OpenAPI schema, got number',
    );
    expect(() => normalizeSchema('{"type":"string"}', 'response body')).toThrow(
      'response body must be an OpenAPI schema, got string',
    );
    expect(() => normalizeSchema([], 'response body')).toThrow(
      'response body must be an OpenAPI schema, got array',
    );
  });

  it('should return a plain object schema by reference', () => {
    const schema = {type: 'string'};

    expect(normalizeSchema(schema, 'response body')).toBe(schema);
  });
});

describe('toSnakeCaseName', () => {
  it('should snake_case a camelCase name', () => {
    expect(toSnakeCaseName('testParam')).toBe('test_param');
  });

  it('should drop the leading underscore of a PascalCase name', () => {
    expect(toSnakeCaseName('TestParam')).toBe('test_param');
  });

  it('should leave a snake_case name alone', () => {
    expect(toSnakeCaseName('test_param')).toBe('test_param');
  });
});

describe('getTypeHint', () => {
  const cases: Array<{name: string; schema: unknown; expected: string}> = [
    {name: 'integer', schema: {type: 'integer'}, expected: 'number'},
    {name: 'number', schema: {type: 'number'}, expected: 'number'},
    {name: 'boolean', schema: {type: 'boolean'}, expected: 'boolean'},
    {name: 'string', schema: {type: 'string'}, expected: 'string'},
    {
      name: 'object',
      schema: {type: 'object'},
      expected: 'Record<string, unknown>',
    },
    {
      name: 'an integer array',
      schema: {type: 'array', items: {type: 'integer'}},
      expected: 'number[]',
    },
    {
      name: 'a number array',
      schema: {type: 'array', items: {type: 'number'}},
      expected: 'number[]',
    },
    {
      name: 'a boolean array',
      schema: {type: 'array', items: {type: 'boolean'}},
      expected: 'boolean[]',
    },
    {
      name: 'a string array',
      schema: {type: 'array', items: {type: 'string'}},
      expected: 'string[]',
    },
    {
      name: 'an object array',
      schema: {type: 'array', items: {type: 'object'}},
      expected: 'Record<string, unknown>[]',
    },
    {
      name: 'an array without items',
      schema: {type: 'array'},
      expected: 'unknown[]',
    },
    {
      name: 'an array of referenced items',
      schema: {type: 'array', items: {$ref: '#/components/schemas/Pet'}},
      expected: 'unknown[]',
    },
    {
      name: 'an array of arrays',
      schema: {type: 'array', items: {type: 'array', items: {type: 'string'}}},
      expected: 'unknown[]',
    },
    {
      name: 'an array of untyped items',
      schema: {type: 'array', items: {}},
      expected: 'unknown[]',
    },
    {name: 'a schema with no type', schema: {}, expected: 'unknown'},
    {
      name: 'an unmapped type',
      schema: {type: 'null'},
      expected: 'unknown',
    },
    {
      name: 'a date-formatted string',
      schema: {type: 'string', format: 'date'},
      expected: 'string',
    },
    {
      name: 'a date-time-formatted string',
      schema: {type: 'string', format: 'date-time'},
      expected: 'string',
    },
    {
      name: 'a nullable type array',
      schema: {type: ['string', 'null']},
      expected: 'string',
    },
    {
      name: 'a multi-type array',
      schema: {type: ['string', 'number']},
      expected: 'unknown',
    },
    {
      name: 'a null-only type array',
      schema: {type: ['null']},
      expected: 'unknown',
    },
    {
      name: 'an empty type array',
      schema: {type: []},
      expected: 'unknown',
    },
    {
      name: 'a type array of non-strings',
      schema: {type: [1]},
      expected: 'unknown',
    },
  ];

  for (const {name, schema, expected} of cases) {
    it(`should type ${name} as ${expected}`, () => {
      expect(getTypeHint(normalizeSchema(schema, 'test schema'))).toBe(
        expected,
      );
    });
  }
});

describe('createApiParameter', () => {
  it('should derive the name, schema and description', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string', description: 'A string parameter'},
      description: 'A string description',
    });

    expect(param.originalName).toBe('testParam');
    expect(param.paramLocation).toBe('query');
    expect(param.name).toBe('test_param');
    expect(param.description).toBe('A string description');
    expect(param.required).toBe(false);
    expect(getTypeHint(param.paramSchema)).toBe('string');
  });

  const locationDefaults: Array<[string, string]> = [
    ['body', 'body'],
    ['query', 'query_param'],
    ['path', 'path_param'],
    ['header', 'header_param'],
    ['cookie', 'cookie_param'],
    ['', 'value'],
    ['trailer', 'value'],
  ];

  for (const [location, expected] of locationDefaults) {
    it(`should name an unnamed ${location || 'unplaced'} parameter ${expected}`, () => {
      const param = createApiParameter({
        originalName: '',
        paramLocation: location,
        paramSchema: {type: 'string'},
      });

      expect(param.name).toBe(expected);
    });
  }

  it('should keep an explicit name', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'integer'},
      name: 'custom_name',
    });

    expect(param.name).toBe('custom_name');
  });

  it('should fall back to the schema description', () => {
    const param = createApiParameter({
      originalName: 'param1',
      paramLocation: 'query',
      paramSchema: {type: 'string', description: 'The description'},
    });

    expect(param.description).toBe('The description');
  });

  it('should default the description to an empty string', () => {
    const param = createApiParameter({
      originalName: 'param1',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
    });

    expect(param.description).toBe('');
  });

  it('should name the parameter in a schema error', () => {
    expect(() =>
      createApiParameter({
        originalName: 'petId',
        paramLocation: 'path',
        paramSchema: false,
      }),
    ).toThrow("parameter 'petId' uses an unsatisfiable false schema");
  });
});

describe('generateParamDoc', () => {
  it('should document a simple parameter', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      description: 'Test description',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (string): Test description',
    );
  });

  it('should accept a parameter that declares no description', () => {
    const param: ApiParameter = {
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      name: 'test_param',
      required: false,
    };

    expect(generateParamDoc(param)).toBe('test_param (string): ');
  });

  it('should keep the trailing space when there is no description', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {type: 'integer'},
    });

    expect(generateParamDoc(param)).toBe('test_param (number): ');
  });

  it('should document the properties of an object parameter', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {
        type: 'object',
        properties: {
          prop1: {type: 'string', description: 'Prop1 desc'},
          prop2: {type: 'integer'},
        },
      },
      description: 'Test object parameter',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): Test object parameter Object' +
        ' properties:\n       prop1 (string): Prop1 desc\n       prop2' +
        ' (number): \n',
    );
  });

  it('should document a referenced property as unknown', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {
        type: 'object',
        properties: {prop1: {$ref: '#/components/schemas/Pet'}},
      },
      description: 'Test object parameter',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): Test object parameter Object' +
        ' properties:\n       prop1 (unknown): \n',
    );
  });

  it('should omit the properties block for an object with no properties', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {type: 'object', description: 'A test schema'},
      description: 'The description.',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): The description.',
    );
  });

  it('should omit the properties block for an empty properties map', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {type: 'object', properties: {}},
      description: 'The description.',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): The description.',
    );
  });

  it('should omit the properties block for a nullable object type', () => {
    const nullableObject: unknown = {
      type: ['object', 'null'],
      properties: {prop1: {type: 'string'}},
    };
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: normalizeSchema(nullableObject, 'test schema'),
      description: 'The description.',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): The description.',
    );
  });
});

describe('generateReturnDoc', () => {
  it('should document a simple return value', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: 'Successful response',
        content: {'application/json': {schema: {type: 'string'}}},
      },
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (string): Successful response',
    );
  });

  it('should return nothing for a response without content', () => {
    expect(generateReturnDoc({'204': {description: 'No content'}})).toBe('');
  });

  it('should return nothing for a response with an empty content map', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {description: 'Successful response', content: {}},
    };

    expect(generateReturnDoc(responses)).toBe('');
  });

  it('should document the properties of an object return value', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: 'Successful object response',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                prop1: {type: 'string', description: 'Prop1 desc'},
                prop2: {type: 'integer'},
              },
            },
          },
        },
      },
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (Record<string, unknown>): Successful object response Object' +
        ' properties:\n        prop1 (string): Prop1 desc\n        prop2' +
        ' (number): \n',
    );
  });

  it('should ignore a non-2xx response', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: 'Successful response',
        content: {'application/json': {schema: {type: 'string'}}},
      },
      '400': {description: 'Bad request'},
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (string): Successful response',
    );
  });

  it('should take the smallest 2xx status code', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '201': {
        description: '201 response',
        content: {'application/json': {schema: {type: 'integer'}}},
      },
      '200': {
        description: '200 response',
        content: {'application/json': {schema: {type: 'string'}}},
      },
      '400': {description: 'Bad request'},
    };

    expect(generateReturnDoc(responses)).toBe('Returns (string): 200 response');
  });

  it('should sort a numeric status key before a non-numeric one', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '2XX': {
        description: 'Range response',
        content: {'application/json': {schema: {type: 'integer'}}},
      },
      '200': {
        description: 'Successful response',
        content: {'application/json': {schema: {type: 'string'}}},
      },
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (string): Successful response',
    );
  });

  it('should ignore a default response alongside a 2xx one', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: 'Successful response',
        content: {'application/json': {schema: {type: 'string'}}},
      },
      default: {
        description: 'Unexpected error',
        content: {'application/json': {schema: {type: 'object'}}},
      },
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (string): Successful response',
    );
  });

  it('should return nothing when only a default response exists', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      default: {
        description: 'Unexpected error',
        content: {'application/json': {schema: {type: 'object'}}},
      },
    };

    expect(generateReturnDoc(responses)).toBe('');
  });

  it('should order two non-numeric 2xx keys by string', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '2YY': {
        description: 'Second range',
        content: {'application/json': {schema: {type: 'integer'}}},
      },
      '2XX': {
        description: 'First range',
        content: {'application/json': {schema: {type: 'string'}}},
      },
    };

    expect(generateReturnDoc(responses)).toBe('Returns (string): First range');
  });

  it('should skip a 2xx response that has no content', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {description: 'No content response'},
      '201': {
        description: '201 response',
        content: {'application/json': {schema: {type: 'string'}}},
      },
      '400': {description: 'Bad request'},
    };

    expect(generateReturnDoc(responses)).toBe('Returns (string): 201 response');
  });

  it('should prefer JSON over another content type', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: 'Successful response',
        content: {
          'application/xml': {schema: {type: 'integer'}},
          'application/json': {schema: {type: 'string'}},
        },
      },
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (string): Successful response',
    );
  });

  it('should fall back to the first content type', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: 'Successful response',
        content: {
          'application/xml': {schema: {type: 'integer'}},
          'text/plain': {schema: {type: 'string'}},
        },
      },
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (number): Successful response',
    );
  });

  it('should keep the JSON entry that declares no schema', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: 'Successful response',
        content: {
          'application/json': {},
          'application/xml': {schema: {type: 'integer'}},
        },
      },
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (unknown): Successful response',
    );
  });

  it('should trim the response description', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: '  Successful response  ',
        content: {'application/json': {schema: {type: 'string'}}},
      },
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (string): Successful response',
    );
  });

  it('should accept a response with an empty description', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: '',
        content: {'application/json': {schema: {type: 'string'}}},
      },
    };

    expect(generateReturnDoc(responses)).toBe('Returns (string): ');
  });

  it('should skip a referenced response', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {$ref: '#/components/responses/Ok'},
    };

    expect(generateReturnDoc(responses)).toBe('');
  });

  it('should reject a referenced response schema', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: 'Successful response',
        content: {
          'application/json': {schema: {$ref: '#/components/schemas/Pet'}},
        },
      },
    };

    expect(() => generateReturnDoc(responses)).toThrow(
      "response body contains unresolved reference '#/components/schemas/Pet'",
    );
  });
});
