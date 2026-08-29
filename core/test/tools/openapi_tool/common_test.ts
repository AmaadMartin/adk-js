/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApiParameter,
  getTypeHint,
  getTypeValue,
  normalizeSchema,
  renameReservedWord,
  toSnakeCaseName,
  type TypeValue,
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
    expect(() => normalizeSchema([], 'response body')).toThrow(
      'response body must be an OpenAPI schema, got array',
    );
  });

  it('should parse a schema held as a JSON string', () => {
    expect(normalizeSchema('{"type":"string"}', 'response body')).toEqual({
      type: 'string',
    });
  });

  it('should reject a JSON string that does not parse', () => {
    expect(() => normalizeSchema('{"type":', "parameter 'petId'")).toThrow(
      /parameter 'petId' is not valid JSON: /,
    );
  });

  it('should reject a JSON string holding an array', () => {
    expect(() => normalizeSchema('[]', 'response body')).toThrow(
      'response body must be an OpenAPI schema, got array',
    );
  });

  it('should reject a JSON string holding a scalar', () => {
    expect(() => normalizeSchema('42', 'response body')).toThrow(
      'response body must be an OpenAPI schema, got number',
    );
  });

  it('should reject a JSON string holding null', () => {
    expect(() => normalizeSchema('null', 'response body')).toThrow(
      'response body must be an OpenAPI schema, got null',
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

describe('renameReservedWord', () => {
  const reserved: Array<[string, string]> = [
    ['in', 'param_in'],
    ['for', 'param_for'],
    ['class', 'param_class'],
    ['function', 'param_function'],
    ['default', 'param_default'],
  ];

  for (const [name, expected] of reserved) {
    it(`should prefix the reserved word ${name}`, () => {
      expect(renameReservedWord(name)).toBe(expected);
    });
  }

  it('should leave an ordinary name alone', () => {
    expect(renameReservedWord('normal')).toBe('normal');
  });

  it('should leave an already prefixed name alone', () => {
    expect(renameReservedWord('param_if')).toBe('param_if');
  });

  it('should leave an empty name alone', () => {
    expect(renameReservedWord('')).toBe('');
  });
});

interface TypeCase {
  name: string;
  schema: unknown;
  hint: string;
  value: TypeValue;
}

const TYPE_CASES: TypeCase[] = [
  {
    name: 'integer',
    schema: {type: 'integer'},
    hint: 'number',
    value: {kind: 'integer'},
  },
  {
    name: 'number',
    schema: {type: 'number'},
    hint: 'number',
    value: {kind: 'number'},
  },
  {
    name: 'boolean',
    schema: {type: 'boolean'},
    hint: 'boolean',
    value: {kind: 'boolean'},
  },
  {
    name: 'string',
    schema: {type: 'string'},
    hint: 'string',
    value: {kind: 'string'},
  },
  {
    name: 'object',
    schema: {type: 'object'},
    hint: 'Record<string, unknown>',
    value: {kind: 'object'},
  },
  {
    name: 'an integer array',
    schema: {type: 'array', items: {type: 'integer'}},
    hint: 'Array<number>',
    value: {kind: 'array', items: {kind: 'integer'}},
  },
  {
    name: 'a number array',
    schema: {type: 'array', items: {type: 'number'}},
    hint: 'Array<number>',
    value: {kind: 'array', items: {kind: 'number'}},
  },
  {
    name: 'a boolean array',
    schema: {type: 'array', items: {type: 'boolean'}},
    hint: 'Array<boolean>',
    value: {kind: 'array', items: {kind: 'boolean'}},
  },
  {
    name: 'a string array',
    schema: {type: 'array', items: {type: 'string'}},
    hint: 'Array<string>',
    value: {kind: 'array', items: {kind: 'string'}},
  },
  {
    name: 'an object array',
    schema: {type: 'array', items: {type: 'object'}},
    hint: 'Array<Record<string, unknown>>',
    value: {kind: 'array', items: {kind: 'object'}},
  },
  {
    name: 'an array without items',
    schema: {type: 'array'},
    hint: 'Array<unknown>',
    value: {kind: 'array', items: {kind: 'unknown'}},
  },
  {
    name: 'an array of referenced items',
    schema: {type: 'array', items: {$ref: '#/components/schemas/Pet'}},
    hint: 'Array<unknown>',
    value: {kind: 'array', items: {kind: 'unknown'}},
  },
  {
    name: 'an array of arrays',
    schema: {type: 'array', items: {type: 'array', items: {type: 'string'}}},
    hint: 'Array<unknown>',
    value: {kind: 'array', items: {kind: 'array', items: {kind: 'string'}}},
  },
  {
    name: 'an array of untyped items',
    schema: {type: 'array', items: {}},
    hint: 'Array<unknown>',
    value: {kind: 'array', items: {kind: 'unknown'}},
  },
  {
    name: 'a schema with no type',
    schema: {},
    hint: 'unknown',
    value: {kind: 'unknown'},
  },
  {
    name: 'an unmapped type',
    schema: {type: 'null'},
    hint: 'unknown',
    value: {kind: 'unknown'},
  },
  {
    name: 'a date-formatted string',
    schema: {type: 'string', format: 'date'},
    hint: 'string',
    value: {kind: 'string'},
  },
  {
    name: 'a date-time-formatted string',
    schema: {type: 'string', format: 'date-time'},
    hint: 'string',
    value: {kind: 'string'},
  },
  {
    name: 'a nullable type array',
    schema: {type: ['string', 'null']},
    hint: 'string',
    value: {kind: 'string'},
  },
  {
    name: 'a multi-type array',
    schema: {type: ['string', 'number']},
    hint: 'unknown',
    value: {kind: 'unknown'},
  },
  {
    name: 'a null-only type array',
    schema: {type: ['null']},
    hint: 'unknown',
    value: {kind: 'unknown'},
  },
  {
    name: 'an empty type array',
    schema: {type: []},
    hint: 'unknown',
    value: {kind: 'unknown'},
  },
  {
    name: 'a type array of non-strings',
    schema: {type: [1]},
    hint: 'unknown',
    value: {kind: 'unknown'},
  },
];

describe('getTypeHint and getTypeValue', () => {
  for (const {name, schema, hint, value} of TYPE_CASES) {
    it(`should type ${name} as ${hint}`, () => {
      const normalized = normalizeSchema(schema, 'test schema');

      expect(getTypeHint(normalized)).toBe(hint);
      expect(getTypeValue(normalized)).toEqual(value);
    });

    it(`should expose ${name} on the parameter as ${hint}`, () => {
      const param = new ApiParameter({
        originalName: 'testParam',
        paramLocation: 'query',
        paramSchema: normalizeSchema(schema, 'test schema'),
      });

      expect(param.typeHint).toBe(hint);
      expect(param.typeValue).toEqual(value);
    });
  }

  it('should type a boolean schema as unknown', () => {
    expect(getTypeHint(true)).toBe('unknown');
    expect(getTypeHint(false)).toBe('unknown');
    expect(getTypeValue(true)).toEqual({kind: 'unknown'});
    expect(getTypeValue(false)).toEqual({kind: 'unknown'});
  });

  it('should type a missing schema as unknown', () => {
    expect(getTypeHint(undefined)).toBe('unknown');
    expect(getTypeValue(undefined)).toEqual({kind: 'unknown'});
  });
});

describe('ApiParameter', () => {
  it('should derive the name, schema and description', () => {
    const param = new ApiParameter({
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
    expect(param.typeHint).toBe('string');
    expect(param.typeValue).toEqual({kind: 'string'});
    expect(param.paramSchema).toEqual({
      type: 'string',
      description: 'A string parameter',
    });
  });

  it('should prefix a name that is a reserved word', () => {
    const param = new ApiParameter({
      originalName: 'in',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
    });

    expect(param.name).toBe('param_in');
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
      const param = new ApiParameter({
        originalName: '',
        paramLocation: location,
        paramSchema: {type: 'string'},
      });

      expect(param.name).toBe(expected);
    });
  }

  it('should keep an explicit name', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'integer'},
      name: 'custom_name',
    });

    expect(param.name).toBe('custom_name');
  });

  it('should fall back to the schema description', () => {
    const param = new ApiParameter({
      originalName: 'param1',
      paramLocation: 'query',
      paramSchema: {type: 'string', description: 'The description'},
    });

    expect(param.description).toBe('The description');
  });

  it('should default the description to an empty string', () => {
    const param = new ApiParameter({
      originalName: 'param1',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
    });

    expect(param.description).toBe('');
  });

  it('should name the parameter in a schema error', () => {
    expect(
      () =>
        new ApiParameter({
          originalName: 'petId',
          paramLocation: 'path',
          paramSchema: false,
        }),
    ).toThrow("parameter 'petId' uses an unsatisfiable false schema");
  });

  it('should accept a schema held as a JSON string', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: '{"type": "string", "description": "A string parameter"}',
    });

    expect(param.paramSchema).toEqual({
      type: 'string',
      description: 'A string parameter',
    });
    expect(param.typeHint).toBe('string');
    expect(param.description).toBe('A string parameter');
  });

  it('should type a JSON string schema holding an integer', () => {
    const param = new ApiParameter({
      originalName: 'count',
      paramLocation: 'query',
      paramSchema: '{"type":"integer"}',
    });

    expect(param.typeHint).toBe('number');
    expect(param.typeValue).toEqual({kind: 'integer'});
  });

  it('should name the parameter when its JSON string does not parse', () => {
    expect(
      () =>
        new ApiParameter({
          originalName: 'petId',
          paramLocation: 'path',
          paramSchema: '{"type":',
        }),
    ).toThrow(/parameter 'petId' is not valid JSON: /);
  });

  it('should reject a JSON string schema holding an array', () => {
    expect(
      () =>
        new ApiParameter({
          originalName: 'petId',
          paramLocation: 'path',
          paramSchema: '[{"type":"string"}]',
        }),
    ).toThrow("parameter 'petId' must be an OpenAPI schema, got array");
  });

  it('should serialize the declared fields only', () => {
    const param = new ApiParameter({
      originalName: 'TestParam',
      paramLocation: 'path',
      paramSchema: {type: 'string', description: 'test description'},
      name: 'test_param_custom',
      required: true,
    });

    const serialized: unknown = JSON.parse(JSON.stringify(param));

    expect(serialized).toEqual({
      originalName: 'TestParam',
      paramLocation: 'path',
      paramSchema: {type: 'string', description: 'test description'},
      description: 'test description',
      name: 'test_param_custom',
    });
    expect(Object.keys(param.toJSON())).not.toContain('typeHint');
    expect(Object.keys(param.toJSON())).not.toContain('typeValue');
    expect(Object.keys(param.toJSON())).not.toContain('required');
  });
});
