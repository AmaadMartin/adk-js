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
  OpenApiSpecParser,
  renameReservedWords,
  schemaFromOpenApi,
} from '@google/adk';
import * as fs from 'fs';
import yaml from 'js-yaml';
import {OpenAPIV3} from 'openapi-types';
import * as path from 'path';
import {beforeAll, describe, expect, it} from 'vitest';

describe('renameReservedWords', () => {
  it.each([
    ['in', 'param_in'],
    ['for', 'param_for'],
    ['class', 'param_class'],
    ['normal', 'normal'],
    ['param_if', 'param_if'],
    ['', ''],
  ])('should rename %s to %s', (input, expected) => {
    expect(renameReservedWords(input)).toBe(expected);
  });

  it('should rename a word reserved only in TypeScript', () => {
    expect(renameReservedWords('function')).toBe('param_function');
  });

  it('should leave a word reserved only in Python unchanged', () => {
    expect(renameReservedWords('def')).toBe('def');
  });
});

describe('schemaFromOpenApi', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['true', true],
  ])('should treat %s as an unconstrained schema', (_label, value) => {
    expect(schemaFromOpenApi(value, 'response body')).toEqual({});
  });

  it('should reject a false schema', () => {
    expect(() => schemaFromOpenApi(false, 'response body')).toThrow(
      'response body uses an unsatisfiable false schema',
    );
  });

  it('should reject an array', () => {
    expect(() => schemaFromOpenApi([], 'response body')).toThrow(
      'response body must be an OpenAPI schema, got array',
    );
  });

  it('should reject a number', () => {
    expect(() => schemaFromOpenApi(42, 'response body')).toThrow(
      'response body must be an OpenAPI schema, got number',
    );
  });

  it('should reject a string', () => {
    expect(() =>
      schemaFromOpenApi('{"type":"string"}', 'response body'),
    ).toThrow('response body must be an OpenAPI schema, got string');
  });

  it('should reject an unresolved reference and name it', () => {
    expect(() =>
      schemaFromOpenApi(
        {$ref: '#/components/schemas/Pet'},
        "parameter 'pet' schema",
      ),
    ).toThrow(
      "parameter 'pet' schema contains unresolved reference" +
        " '#/components/schemas/Pet'",
    );
  });

  it('should return a plain object by reference', () => {
    const input = {type: 'string'};
    expect(schemaFromOpenApi(input, 'response body')).toBe(input);
  });
});

describe('createApiParameter', () => {
  it('should derive every field from a fully specified parameter', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      description: 'A string description',
      paramSchema: {type: 'string', description: 'A string parameter'},
    });

    expect(param.originalName).toBe('testParam');
    expect(param.paramLocation).toBe('query');
    expect(param.paramSchema.type).toBe('string');
    expect(param.paramSchema.description).toBe('A string parameter');
    expect(param.name).toBe('test_param');
    expect(param.description).toBe('A string description');
    expect(param.required).toBe(false);
  });

  it('should rename a reserved word', () => {
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
    ['', 'value'],
    ['trailer', 'value'],
    ['constructor', 'value'],
  ])(
    'should name an unnamed %s parameter %s',
    (paramLocation, expectedName) => {
      const param = createApiParameter({
        originalName: '',
        paramLocation,
        paramSchema: {type: 'string'},
      });

      expect(param.name).toBe(expectedName);
    },
  );

  it('should let an explicit name win over the derived one', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'integer'},
      name: 'custom_name',
    });

    expect(param.name).toBe('custom_name');
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

  it('should fall back to the schema description', () => {
    const param = createApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string', description: 'From the schema'},
    });

    expect(param.description).toBe('From the schema');
  });

  it('should fall back to an empty description', () => {
    const param = createApiParameter({
      originalName: 'testParam',
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
        paramSchema: {$ref: '#/components/schemas/Pet'},
      }),
    ).toThrow("parameter 'petId' schema contains unresolved reference");
  });

  it('should not modify its argument', () => {
    const init = {
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: {type: 'string' as const},
    };
    const snapshot = structuredClone(init);

    createApiParameter(init);

    expect(init).toEqual(snapshot);
  });

  it.each([
    ['testParam', 'test_param'],
    ['UpperCamelCase', 'upper_camel_case'],
    ['REST API', 'rest_api'],
    ['user-id', 'user_id'],
    ['space separated', 'space_separated'],
    ['__leading__', 'leading'],
  ])('should derive %s as %s', (originalName, expectedName) => {
    const param = createApiParameter({
      originalName,
      paramLocation: 'query',
      paramSchema: {type: 'string'},
    });

    expect(param.name).toBe(expectedName);
  });
});

describe('getTypeHint', () => {
  it.each([
    ['integer', {type: 'integer'}, 'number'],
    ['number', {type: 'number'}, 'number'],
    ['boolean', {type: 'boolean'}, 'boolean'],
    ['string', {type: 'string'}, 'string'],
    ['formatted string', {type: 'string', format: 'date-time'}, 'string'],
    ['object', {type: 'object'}, 'Record<string, unknown>'],
    ['empty schema', {}, 'unknown'],
    ['unmapped type', {type: 'null'}, 'unknown'],
    [
      'integer array',
      {type: 'array', items: {type: 'integer'}},
      'Array<number>',
    ],
    ['number array', {type: 'array', items: {type: 'number'}}, 'Array<number>'],
    [
      'boolean array',
      {type: 'array', items: {type: 'boolean'}},
      'Array<boolean>',
    ],
    ['string array', {type: 'array', items: {type: 'string'}}, 'Array<string>'],
    [
      'object array',
      {type: 'array', items: {type: 'object'}},
      'Array<Record<string, unknown>>',
    ],
    [
      'nested array',
      {type: 'array', items: {type: 'array', items: {type: 'string'}}},
      'Array<Array<unknown>>',
    ],
    ['itemless array', {type: 'array'}, 'Array<unknown>'],
    ['untyped items', {type: 'array', items: {}}, 'Array<unknown>'],
    [
      'referenced items',
      {type: 'array', items: {$ref: '#/components/schemas/Pet'}},
      'Array<unknown>',
    ],
    ['nullable union', {type: ['string', 'null']}, 'string'],
    ['ambiguous union', {type: ['string', 'number']}, 'unknown'],
    ['null-only union', {type: ['null']}, 'unknown'],
    ['non-string union entry', {type: [42]}, 'unknown'],
  ])('should hint a %s as %s', (_label, schema, expected) => {
    expect(getTypeHint(schema)).toBe(expected);
  });

  it('should hint a boolean schema as unknown', () => {
    expect(getTypeHint(true)).toBe('unknown');
  });

  it('should hint a missing schema as unknown', () => {
    expect(getTypeHint(null)).toBe('unknown');
  });

  it('should hint an array as unknown', () => {
    expect(getTypeHint([])).toBe('unknown');
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

  it('should document a parameter with no description', () => {
    const param: ApiParameter = {
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {type: 'integer'},
      name: 'test_param',
      required: false,
    };

    expect(generateParamDoc(param)).toBe('test_param (number): ');
  });

  it('should document the properties of an object parameter', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      description: 'Test object parameter',
      paramSchema: {
        type: 'object',
        properties: {
          prop1: {type: 'string', description: 'Prop1 desc'},
          prop2: {type: 'integer'},
          prop3: {$ref: '#/components/schemas/Pet'},
        },
      },
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): Test object parameter Object' +
        ' properties:\n       prop1 (string): Prop1 desc\n       prop2' +
        ' (number): \n       prop3 (unknown): \n',
    );
  });

  it('should omit the property block when the object declares none', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      description: 'The description.',
      paramSchema: {type: 'object', description: 'A test schema'},
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): The description.',
    );
  });

  it('should omit the property block when the property map is empty', () => {
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      description: 'The description.',
      paramSchema: {type: 'object', properties: {}},
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): The description.',
    );
  });
});

describe('generateReturnDoc', () => {
  it('should document a single successful response', () => {
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

  it('should return nothing when the only response has no content', () => {
    expect(generateReturnDoc({'204': {description: 'No content'}})).toBe('');
  });

  it('should return nothing when the only response has empty content', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {description: 'Successful response', content: {}},
    };

    expect(generateReturnDoc(responses)).toBe('');
  });

  it('should document the properties of an object response', () => {
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

  it('should ignore a failure response', () => {
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

  it('should pick the lowest 2xx status code numerically', () => {
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

  it('should sort a numeric status code before "default"', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      'default': {
        description: 'Unexpected error',
        content: {'application/json': {schema: {type: 'object'}}},
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

  it('should return nothing when only "default" carries content', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      'default': {
        description: 'Unexpected error',
        content: {'application/json': {schema: {type: 'object'}}},
      },
    };

    expect(generateReturnDoc(responses)).toBe('');
  });

  it('should ignore a non-numeric failure range', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '4XX': {
        description: 'Client error',
        content: {'application/json': {schema: {type: 'object'}}},
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

  it('should accept a non-numeric success range as the only candidate', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '2XX': {
        description: 'Success range',
        content: {'application/json': {schema: {type: 'string'}}},
      },
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (string): Success range',
    );
  });

  it('should prefer a numeric status code over a success range', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '2XX': {
        description: 'Success range',
        content: {'application/json': {schema: {type: 'object'}}},
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

  it('should ignore a referenced response entry', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '201': {$ref: '#/components/responses/Created'},
      '200': {
        description: 'Successful response',
        content: {'application/json': {schema: {type: 'string'}}},
      },
    };

    expect(generateReturnDoc(responses)).toBe(
      'Returns (string): Successful response',
    );
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

  it('should hint a content type that declares no schema', () => {
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

  it('should document a response that has no description', () => {
    const responses: OpenAPIV3.ResponsesObject = {
      '200': {
        description: '',
        content: {'application/json': {schema: {type: 'string'}}},
      },
    };

    expect(generateReturnDoc(responses)).toBe('Returns (string): ');
  });
});

describe('null values from YAML', () => {
  function loadResponses(document: string): OpenAPIV3.ResponsesObject {
    return yaml.load(document) as OpenAPIV3.ResponsesObject;
  }

  it('should ignore a response key that has no value', () => {
    const responses = loadResponses(`
'200':
`);

    expect(responses).toEqual({'200': null});
    expect(generateReturnDoc(responses)).toBe('');
  });

  it('should ignore a content type that has no value', () => {
    const responses = loadResponses(`
'200':
  description: Successful response
  content:
    application/json:
`);

    expect(generateReturnDoc(responses)).toBe('');
  });

  it('should ignore a content block that has no value', () => {
    const responses = loadResponses(`
'200':
  description: Successful response
  content:
`);

    expect(generateReturnDoc(responses)).toBe('');
  });

  it('should document a response that declares no description', () => {
    const responses = loadResponses(`
'200':
  content:
    application/json:
      schema:
        type: string
`);

    expect(generateReturnDoc(responses)).toBe('Returns (string): ');
  });

  it('should document a property that has no value', () => {
    const paramSchema = yaml.load(`
type: object
properties:
  prop1:
`) as OpenAPIV3.SchemaObject;
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      description: 'Test object parameter',
      paramSchema,
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): Test object parameter Object' +
        ' properties:\n       prop1 (unknown): \n',
    );
  });

  it('should ignore a property block that has no value', () => {
    const paramSchema = yaml.load(`
type: object
properties:
`) as OpenAPIV3.SchemaObject;
    const param = createApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      description: 'Test object parameter',
      paramSchema,
    });

    expect(generateParamDoc(param)).toBe(
      'test_param (Record<string, unknown>): Test object parameter',
    );
  });
});

describe('petstore spec', () => {
  let getPetById: OpenAPIV3.OperationObject;
  let parameterDocs: string[];

  beforeAll(() => {
    const specPath = path.resolve(__dirname, '../fixtures/petstore.yaml');
    const spec = yaml.load(
      fs.readFileSync(specPath, 'utf8'),
    ) as OpenAPIV3.Document;
    const operations = new OpenApiSpecParser().parse(spec);
    const parsed = operations.find((o) => o.name === 'get_pet_by_id');
    if (!parsed) {
      expect.fail('the petstore spec should yield a get_pet_by_id operation');
    }
    getPetById = parsed.operation;
    parameterDocs = parsed.parameters.map(generateParamDoc);
  });

  it('should document the path parameter', () => {
    expect(parameterDocs).toEqual(['pet_id (number): ID of pet to return']);
  });

  it('should document the resolved return value', () => {
    const returnDoc = generateReturnDoc(getPetById.responses);

    expect(returnDoc).toContain(
      'Returns (Record<string, unknown>): successful operation Object' +
        ' properties:\n',
    );
    expect(returnDoc).toContain('        name (string): \n');
    expect(returnDoc).toContain('        photoUrls (Array<string>): \n');
    expect(returnDoc).toContain(
      '        tags (Array<Record<string, unknown>>): \n',
    );
  });
});
