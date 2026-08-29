/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createApiParameter,
  formatApiParameter,
  generateParamDoc,
  generateReturnDoc,
  getSchemaTypeHint,
  getSchemaTypeValue,
  normalizeOpenApiSchema,
  renameReservedKeyword,
  serializeApiParameter,
  toArgString,
  toDictProperty,
  type ApiParameter,
  type TypeValue,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

/**
 * Builds a schema the OpenAPI 3.0 typings cannot describe.
 *
 * An array schema without `items`, an OpenAPI 3.1 union type and a boolean
 * `items` all reach these helpers from a real document, and `SchemaObject`
 * rejects all three. A JSON string is the boundary the module documents for
 * exactly that input.
 */
function schemaFromJson(json: string): OpenAPIV3.SchemaObject {
  return normalizeOpenApiSchema(json, 'test schema');
}

describe('renameReservedKeyword', () => {
  it.each([
    ['in', 'param_in'],
    ['for', 'param_for'],
    ['class', 'param_class'],
    ['function', 'param_function'],
    ['normal', 'normal'],
    ['param_if', 'param_if'],
    ['', ''],
  ])('should rename %s to %s', (input, expected) => {
    expect(renameReservedKeyword(input)).toBe(expected);
  });

  it('should apply a custom prefix', () => {
    expect(renameReservedKeyword('class', 'arg_')).toBe('arg_class');
  });

  it('should leave a name that is not reserved alone under a custom prefix', () => {
    expect(renameReservedKeyword('normal', 'arg_')).toBe('normal');
  });
});

describe('normalizeOpenApiSchema', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['true', true],
  ])('should return an empty schema for %s', (_name, value) => {
    expect(normalizeOpenApiSchema(value, 'field')).toEqual({});
  });

  it('should reject a false schema', () => {
    expect(() => normalizeOpenApiSchema(false, 'field')).toThrow(
      'field uses an unsatisfiable false schema',
    );
  });

  it('should parse a schema held as a JSON string', () => {
    expect(normalizeOpenApiSchema('{"type":"string"}', 'field')).toEqual({
      type: 'string',
    });
  });

  it('should reject a string that is not valid JSON', () => {
    expect(() => normalizeOpenApiSchema('{oops', 'field')).toThrow(
      'field is not valid JSON',
    );
  });

  it('should reject a JSON string holding a scalar', () => {
    expect(() => normalizeOpenApiSchema('"nope"', 'field')).toThrow(
      'field must be an OpenAPI schema, got string',
    );
  });

  it('should reject a JSON string holding an array', () => {
    expect(() => normalizeOpenApiSchema('[]', 'field')).toThrow(
      'field must be an OpenAPI schema, got array',
    );
  });

  it('should reject an array', () => {
    expect(() => normalizeOpenApiSchema([], 'field')).toThrow(
      'field must be an OpenAPI schema, got array',
    );
  });

  it('should reject a number', () => {
    expect(() => normalizeOpenApiSchema(7, 'field')).toThrow(
      'field must be an OpenAPI schema, got number',
    );
  });

  it('should reject an unresolved reference and name it', () => {
    expect(() =>
      normalizeOpenApiSchema({$ref: '#/components/schemas/Pet'}, 'field'),
    ).toThrow("field contains unresolved reference '#/components/schemas/Pet'");
  });

  it('should return a plain schema by reference', () => {
    const schema = {type: 'string'};
    expect(normalizeOpenApiSchema(schema, 'field')).toBe(schema);
  });
});

describe('schema type mapping', () => {
  const cases: Array<[string, OpenAPIV3.SchemaObject, TypeValue, string]> = [
    ['integer', {type: 'integer'}, {kind: 'integer'}, 'number'],
    ['number', {type: 'number'}, {kind: 'number'}, 'number'],
    ['boolean', {type: 'boolean'}, {kind: 'boolean'}, 'boolean'],
    ['string', {type: 'string'}, {kind: 'string'}, 'string'],
    [
      'date string',
      {type: 'string', format: 'date'},
      {kind: 'string'},
      'string',
    ],
    [
      'date-time string',
      {type: 'string', format: 'date-time'},
      {kind: 'string'},
      'string',
    ],
    [
      'integer array',
      {type: 'array', items: {type: 'integer'}},
      {kind: 'array', items: {kind: 'integer'}},
      'Array<number>',
    ],
    [
      'string array',
      {type: 'array', items: {type: 'string'}},
      {kind: 'array', items: {kind: 'string'}},
      'Array<string>',
    ],
    [
      'object array',
      {type: 'array', items: {type: 'object'}},
      {kind: 'array', items: {kind: 'record'}},
      'Array<Record<string, unknown>>',
    ],
    [
      'array of arrays',
      {type: 'array', items: {type: 'array', items: {type: 'string'}}},
      {kind: 'array', items: {kind: 'array', items: {kind: 'unknown'}}},
      'Array<Array<unknown>>',
    ],
    [
      'array of references',
      {type: 'array', items: {$ref: '#/components/schemas/Pet'}},
      {kind: 'array', items: {kind: 'unknown'}},
      'Array<unknown>',
    ],
    ['object', {type: 'object'}, {kind: 'record'}, 'Record<string, unknown>'],
    ['empty schema', {}, {kind: 'unknown'}, 'unknown'],
  ];

  it.each(cases)('should map a %s schema', (_name, schema, value, hint) => {
    expect(getSchemaTypeValue(schema)).toEqual(value);
    expect(getSchemaTypeHint(schema)).toBe(hint);
  });

  const jsonCases: Array<[string, string, TypeValue, string]> = [
    [
      'array without items',
      '{"type":"array"}',
      {kind: 'array', items: {kind: 'unknown'}},
      'Array<unknown>',
    ],
    [
      'array with a boolean items schema',
      '{"type":"array","items":true}',
      {kind: 'array', items: {kind: 'unknown'}},
      'Array<unknown>',
    ],
    [
      'nullable string union',
      '{"type":["string","null"]}',
      {kind: 'string'},
      'string',
    ],
    [
      'ambiguous union',
      '{"type":["string","number"]}',
      {kind: 'unknown'},
      'unknown',
    ],
    ['null-only union', '{"type":["null"]}', {kind: 'unknown'}, 'unknown'],
    ['empty union', '{"type":[]}', {kind: 'unknown'}, 'unknown'],
    [
      'union holding a non-string entry',
      '{"type":[7]}',
      {kind: 'unknown'},
      'unknown',
    ],
    [
      'array of a nullable union',
      '{"type":"array","items":{"type":["integer","null"]}}',
      {kind: 'array', items: {kind: 'integer'}},
      'Array<number>',
    ],
    ['unrecognized type', '{"type":"file"}', {kind: 'unknown'}, 'unknown'],
  ];

  it.each(jsonCases)('should map a %s', (_name, json, value, hint) => {
    const schema = schemaFromJson(json);
    expect(getSchemaTypeValue(schema)).toEqual(value);
    expect(getSchemaTypeHint(schema)).toBe(hint);
  });
});

describe('createApiParameter', () => {
  it('should derive the name, description and type from the schema', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string', description: 'Test description'},
    });

    expect(param.name).toBe('test_param');
    expect(param.originalName).toBe('testParam');
    expect(param.paramLocation).toBe('query');
    expect(param.description).toBe('Test description');
    expect(param.typeHint).toBe('string');
    expect(param.typeValue).toEqual({kind: 'string'});
    expect(param.required).toBe(false);
  });

  it('should prefer an explicit description over the schema description', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string', description: 'From schema'},
      description: 'Explicit',
    });

    expect(param.description).toBe('Explicit');
  });

  it('should fall back to an empty description', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
    });

    expect(param.description).toBe('');
  });

  it('should rename a parameter named after a reserved word', () => {
    const param = createApiParameter({
      originalName: 'in',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
    });

    expect(param.name).toBe('param_in');
  });

  it.each([
    ['body', 'body'],
    ['query', 'query_param'],
    ['path', 'path_param'],
    ['header', 'header_param'],
    ['cookie', 'cookie_param'],
    ['unknown', 'value'],
    ['constructor', 'value'],
  ])('should name an unnamed %s parameter %s', (location, expected) => {
    const param = createApiParameter({
      originalName: '',
      paramLocation: location,
      paramSchema: {type: 'string'},
    });

    expect(param.name).toBe(expected);
  });

  it('should let an explicit name win', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      name: 'chosen',
    });

    expect(param.name).toBe('chosen');
  });

  it('should keep an explicit required flag', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      required: true,
    });

    expect(param.required).toBe(true);
  });

  it('should parse a schema held as a JSON string', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: '{"type":"string","description":"From JSON"}',
    });

    expect(param.paramSchema).toEqual({
      type: 'string',
      description: 'From JSON',
    });
    expect(param.typeHint).toBe('string');
    expect(param.description).toBe('From JSON');
  });

  it('should reject a JSON string schema that does not parse', () => {
    expect(() =>
      createApiParameter({
        originalName: 'petId',
        paramLocation: 'query',
        paramSchema: '{oops',
      }),
    ).toThrow("parameter 'petId' schema is not valid JSON");
  });

  it.each([
    ['a scalar', '"nope"', 'got string'],
    ['an array', '[]', 'got array'],
  ])(
    'should reject a JSON string schema holding %s',
    (_name, json, expected) => {
      expect(() =>
        createApiParameter({
          originalName: 'petId',
          paramLocation: 'query',
          paramSchema: json,
        }),
      ).toThrow(
        `parameter 'petId' schema must be an OpenAPI schema, ${expected}`,
      );
    },
  );

  it('should treat an absent schema as unconstrained', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
    });

    expect(param.paramSchema).toEqual({});
    expect(param.typeHint).toBe('unknown');
    expect(param.typeValue).toEqual({kind: 'unknown'});
  });

  it('should treat a true schema as unconstrained', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: true,
    });

    expect(param.paramSchema).toEqual({});
  });

  it('should reject a false schema', () => {
    expect(() =>
      createApiParameter({
        originalName: 'petId',
        paramLocation: 'query',
        paramSchema: false,
      }),
    ).toThrow("parameter 'petId' schema uses an unsatisfiable false schema");
  });

  it('should reject an unresolved reference and name it', () => {
    expect(() =>
      createApiParameter({
        originalName: 'petId',
        paramLocation: 'query',
        paramSchema: {$ref: '#/components/schemas/Pet'},
      }),
    ).toThrow("contains unresolved reference '#/components/schemas/Pet'");
  });

  it('should not modify the values it was given', () => {
    const init = {
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string' as const, description: 'From schema'},
    };
    const clone = structuredClone(init);

    createApiParameter(init);

    expect(init).toEqual(clone);
  });
});

describe('generateParamDoc', () => {
  it('should document a scalar parameter', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      description: 'Test description',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (string): Test description',
    );
  });

  it('should keep the separator when there is no description', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'number'},
    });

    expect(generateParamDoc(param)).toBe('test_param (number): ');
  });

  it('should trim the description', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      description: '  padded  ',
    });

    expect(generateParamDoc(param)).toBe('test_param (string): padded');
  });

  it('should list the properties of an object parameter', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'body',
      paramSchema: {
        type: 'object',
        properties: {
          prop1: {type: 'string', description: 'Prop1 desc'},
          prop2: {type: 'number'},
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

  it('should list the properties of a nullable object parameter', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'body',
      paramSchema:
        '{"type":["object","null"],"properties":{"p":{"type":"string"}}}',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>):  Object properties:\n' +
        '       p (string): \n',
    );
  });

  it('should omit the property list when an object declares none', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'body',
      paramSchema: {type: 'object'},
      description: 'Test object parameter',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): Test object parameter',
    );
  });

  it('should omit the property list when properties is empty', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'body',
      paramSchema: {type: 'object', properties: {}},
      description: 'Test object parameter',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): Test object parameter',
    );
  });

  it('should not list properties declared outside an object schema', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string', properties: {p: {type: 'string'}}},
      description: 'Test parameter',
    });

    expect(generateParamDoc(param)).toBe('test_param (string): Test parameter');
  });

  it('should document a property that is an unresolved reference', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'body',
      paramSchema: {
        type: 'object',
        properties: {owner: {$ref: '#/components/schemas/Owner'}},
      },
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>):  Object properties:\n' +
        '       owner (unknown): \n',
    );
  });

  it('should document a property that is a boolean schema', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'body',
      paramSchema: '{"type":"object","properties":{"anything":true}}',
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>):  Object properties:\n' +
        '       anything (unknown): \n',
    );
  });
});

describe('generateReturnDoc', () => {
  it('should document a successful response', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: 'Successful response',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): Successful response');
  });

  it('should trim the description', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: '  Successful response  ',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): Successful response');
  });

  it('should list the properties of an object response', () => {
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
                  prop2: {type: 'number'},
                },
              },
            },
          },
        },
      }),
    ).toBe(
      'Returns (Record<string, unknown>): Successful object response' +
        ' Object properties:\n' +
        '       prop1 (string): Prop1 desc\n' +
        '       prop2 (number): \n',
    );
  });

  it('should return nothing for a response without content', () => {
    expect(generateReturnDoc({'204': {description: 'No content'}})).toBe('');
  });

  it('should return nothing when there is no response at all', () => {
    expect(generateReturnDoc({})).toBe('');
  });

  it('should return nothing when only a non-numeric key is declared', () => {
    expect(
      generateReturnDoc({
        default: {
          description: 'Unexpected error',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('');
  });

  it('should skip a response that is an unresolved reference', () => {
    expect(
      generateReturnDoc({'200': {$ref: '#/components/responses/Ok'}}),
    ).toBe('');
  });

  it('should skip a response whose content is empty', () => {
    expect(
      generateReturnDoc({'200': {description: 'Empty', content: {}}}),
    ).toBe('');
  });

  it('should ignore a failure response', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: 'Successful response',
          content: {'application/json': {schema: {type: 'string'}}},
        },
        '400': {
          description: 'Bad request',
          content: {'application/json': {schema: {type: 'object'}}},
        },
      }),
    ).toBe('Returns (string): Successful response');
  });

  it('should take the lowest success code', () => {
    expect(
      generateReturnDoc({
        '201': {
          description: 'Created',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
        '200': {
          description: 'OK',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): OK');
  });

  it('should ignore a default response alongside a success code', () => {
    expect(
      generateReturnDoc({
        default: {
          description: 'Unexpected error',
          content: {'application/json': {schema: {type: 'object'}}},
        },
        '200': {
          description: 'OK',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): OK');
  });

  it('should ignore a failure range alongside a success code', () => {
    expect(
      generateReturnDoc({
        '4XX': {
          description: 'Client error',
          content: {'application/json': {schema: {type: 'object'}}},
        },
        '200': {
          description: 'OK',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): OK');
  });

  it('should prefer a numeric success code over a success range', () => {
    expect(
      generateReturnDoc({
        '2XX': {
          description: 'Any success',
          content: {'application/json': {schema: {type: 'object'}}},
        },
        '200': {
          description: 'OK',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): OK');
  });

  it('should order two success ranges alphabetically', () => {
    expect(
      generateReturnDoc({
        '2XX': {
          description: 'Any success',
          content: {'application/json': {schema: {type: 'object'}}},
        },
        '2AX': {
          description: 'Earlier range',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      }),
    ).toBe('Returns (string): Earlier range');
  });

  it('should keep the earlier success range when it comes first', () => {
    expect(
      generateReturnDoc({
        '2AX': {
          description: 'Earlier range',
          content: {'application/json': {schema: {type: 'string'}}},
        },
        '2XX': {
          description: 'Any success',
          content: {'application/json': {schema: {type: 'object'}}},
        },
      }),
    ).toBe('Returns (string): Earlier range');
  });

  it('should skip a success code that carries no content', () => {
    expect(
      generateReturnDoc({
        '200': {description: 'OK'},
        '201': {
          description: 'Created',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
      }),
    ).toBe('Returns (number): Created');
  });

  it('should prefer the JSON media type', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: 'Successful response',
          content: {
            'application/xml': {schema: {type: 'object'}},
            'application/json': {schema: {type: 'string'}},
          },
        },
      }),
    ).toBe('Returns (string): Successful response');
  });

  it('should prefer the JSON media type even when it declares no schema', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: 'Successful response',
          content: {
            'application/json': {},
            'application/xml': {schema: {type: 'string'}},
          },
        },
      }),
    ).toBe('Returns (unknown): Successful response');
  });

  it('should take the first media type when JSON is absent', () => {
    expect(
      generateReturnDoc({
        '200': {
          description: 'Successful response',
          content: {
            'application/xml': {schema: {type: 'number'}},
            'text/plain': {schema: {type: 'string'}},
          },
        },
      }),
    ).toBe('Returns (number): Successful response');
  });

  it('should document a response that declares no description', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: '',
        content: {'application/json': {schema: {type: 'string'}}},
      },
    };
    Reflect.deleteProperty(responses['200'], 'description');

    expect(generateReturnDoc(responses)).toBe('Returns (string): ');
  });

  it('should reject a response schema that is an unresolved reference', () => {
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

describe('parameter rendering', () => {
  const param = createApiParameter({
    originalName: 'testParam',
    paramLocation: 'query',
    paramSchema: {type: 'number'},
  });

  it('should render an argument binding', () => {
    expect(toArgString(param)).toBe('test_param: test_param');
  });

  it('should render a quoted object property', () => {
    expect(toDictProperty(param)).toBe('"test_param": test_param');
  });

  it('should render a name and its type', () => {
    expect(formatApiParameter(param)).toBe('test_param: number');
  });
});

describe('serializeApiParameter', () => {
  it('should project the declared fields only', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      description: 'Test description',
      required: true,
    });

    const serialized = serializeApiParameter(param);

    expect(serialized).toEqual({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      description: 'Test description',
      name: 'test_param',
    });
    expect(Object.keys(serialized)).not.toContain('typeValue');
    expect(Object.keys(serialized)).not.toContain('typeHint');
    expect(Object.keys(serialized)).not.toContain('required');
  });

  it('should omit an absent description', () => {
    const param: ApiParameter = {
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      name: 'test_param',
      required: false,
    };

    expect(Object.keys(serializeApiParameter(param))).not.toContain(
      'description',
    );
  });
});
