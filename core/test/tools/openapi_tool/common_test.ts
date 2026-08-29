/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApiParameter,
  generateParamDoc,
  generateReturnDoc,
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

  it('should apply a custom prefix', () => {
    expect(renameReservedWord('class', 'arg_')).toBe('arg_class');
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

  it('should render the argument as name and type', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'number'},
    });

    expect(String(param)).toBe('test_param: number');
    expect(param.toString()).toBe('test_param: number');
  });

  it('should render the argument as a call-site argument', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'number'},
    });

    expect(param.toArgString()).toBe('test_param=test_param');
  });

  it('should render the argument as an object entry', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'number'},
    });

    expect(param.toDictProperty()).toBe('"test_param": test_param');
  });

  it('should render the argument documentation', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      description: 'Test description',
    });

    expect(param.toDocString()).toBe('test_param (string): Test description');
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

describe('generateParamDoc', () => {
  it('should render the name, type and description', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      description: 'Test description',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (string): Test description',
    );
  });

  it('should keep the trailing space when there is no description', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'number'},
    });

    expect(generateParamDoc(param)).toBe('test_param (number): ');
  });

  it('should enumerate the properties of an object parameter', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'body',
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
      'test_param (Record<string, unknown>): Test object parameter' +
        ' Object properties:\n' +
        '       prop1 (string): Prop1 desc\n' +
        '       prop2 (number): \n',
    );
  });

  it('should not enumerate an object parameter with no properties', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'body',
      paramSchema: {type: 'object', properties: {}},
      description: 'Empty object',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): Empty object',
    );
  });

  it('should not enumerate an object parameter without a properties field', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'body',
      paramSchema: {type: 'object'},
      description: 'Untyped object',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): Untyped object',
    );
  });

  it('should render a referenced property as unknown', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'body',
      paramSchema: {
        type: 'object',
        properties: {pet: {$ref: '#/components/schemas/Pet'}},
      },
      description: 'Referencing object',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): Referencing object' +
        ' Object properties:\n' +
        '       pet (unknown): \n',
    );
  });

  it('should not enumerate a nullable object union', () => {
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'body',
      paramSchema: normalizeSchema(
        {type: ['object', 'null'], properties: {prop1: {type: 'string'}}},
        'test schema',
      ),
      description: 'Nullable object',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): Nullable object',
    );
  });
});

describe('generateReturnDoc', () => {
  it('should render the selected 2xx response', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: 'Successful response',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): Successful response');
  });

  it('should return an empty string when no response has content', () => {
    expect(generateReturnDoc({'204': {description: 'No content'}})).toBe('');
  });

  it('should return an empty string for an empty content map', () => {
    expect(
      generateReturnDoc({'200': {description: 'Empty', content: {}}}),
    ).toBe('');
  });

  it('should return an empty string when there are no responses', () => {
    expect(generateReturnDoc({})).toBe('');
  });

  it('should enumerate the properties of an object response', () => {
    expect(
      generateReturnDoc({
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
      }),
    ).toBe(
      'Returns (Record<string, unknown>): Successful object response' +
        ' Object properties:\n' +
        '        prop1 (string): Prop1 desc\n' +
        '        prop2 (number): \n',
    );
  });

  it('should ignore a non-2xx response', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: 'Successful response',
          content: {'application/json': {schema: {type: 'string'}}},
        },
        '400': {
          description: 'Bad request',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
      }),
    ).toBe('Returns (string): Successful response');
  });

  it('should prefer the smaller of two contentful 2xx responses', () => {
    expect(
      generateReturnDoc({
        '201': {
          description: 'Created',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
        '200': {
          description: 'Successful response',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): Successful response');
  });

  it('should skip a contentless 2xx response for a larger contentful one', () => {
    expect(
      generateReturnDoc({
        '200': {description: 'No body'},
        '201': {
          description: 'Created',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
      }),
    ).toBe('Returns (number): Created');
  });

  it('should ignore the default response when a 2xx response exists', () => {
    expect(
      generateReturnDoc({
        default: {
          description: 'Unexpected error',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
        '200': {
          description: 'Successful response',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): Successful response');
  });

  it('should return an empty string for a default response alone', () => {
    expect(
      generateReturnDoc({
        default: {
          description: 'Unexpected error',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
      }),
    ).toBe('');
  });

  it('should prefer a numeric status over a range key', () => {
    expect(
      generateReturnDoc({
        '2XX': {
          description: 'Range response',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
        '4XX': {description: 'Client error'},
        '200': {
          description: 'Successful response',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): Successful response');
  });

  it('should order two range keys as strings', () => {
    expect(
      generateReturnDoc({
        '2XX': {
          description: 'Wide range',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
        '20X': {
          description: 'Narrow range',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): Narrow range');
  });

  it('should prefer application/json over another media type', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: 'Successful response',
          content: {
            'application/xml': {schema: {type: 'integer'}},
            'application/json': {schema: {type: 'string'}},
          },
        },
      }),
    ).toBe('Returns (string): Successful response');
  });

  it('should take the first media type when there is no JSON', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: 'Successful response',
          content: {
            'application/xml': {schema: {type: 'integer'}},
            'text/plain': {schema: {type: 'string'}},
          },
        },
      }),
    ).toBe('Returns (number): Successful response');
  });

  it('should keep application/json even when it has no schema', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: 'Successful response',
          content: {
            'application/xml': {schema: {type: 'integer'}},
            'application/json': {},
          },
        },
      }),
    ).toBe('Returns (unknown): Successful response');
  });

  it('should skip a referenced response entry', () => {
    expect(
      generateReturnDoc({
        '200': {$ref: '#/components/responses/Ok'},
        '201': {
          description: 'Created',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): Created');
  });

  it('should trim the response description', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: '  Successful response  ',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): Successful response');
  });

  it('should render an empty description', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: '',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): ');
  });

  it('should reject an unresolved reference in the response schema', () => {
    expect(() =>
      generateReturnDoc({
        '200': {
          description: 'Successful response',
          content: {
            'application/json': {schema: {$ref: '#/components/schemas/Pet'}},
          },
        },
      }),
    ).toThrow(
      "response body contains unresolved reference '#/components/schemas/Pet'",
    );
  });
});
