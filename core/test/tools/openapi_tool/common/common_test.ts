/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createApiParameter,
  getTypeHint,
  normalizeSchema,
  toSnakeCaseName,
} from '@google/adk';
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
