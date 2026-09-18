/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';
import {
  ApiParameter,
  PydocHelper,
  renamePythonKeywords,
  toSnakeCase,
  TypeHintHelper,
} from '../../../../src/tools/openapi_tool/common/common.js';

describe('toSnakeCase', () => {
  const cases: Array<[string, string]> = [
    ['lowerCamelCase', 'lower_camel_case'],
    ['UpperCamelCase', 'upper_camel_case'],
    ['space separated', 'space_separated'],
    ['REST API', 'rest_api'],
    ['Mixed_CASE with_Spaces', 'mixed_case_with_spaces'],
    ['__init__', 'init'],
    ['APIKey', 'api_key'],
    ['SomeLongURL', 'some_long_url'],
    ['CONSTANT_CASE', 'constant_case'],
    ['already_snake_case', 'already_snake_case'],
    ['single', 'single'],
    ['', ''],
    ['  spaced  ', 'spaced'],
    ['with123numbers', 'with123numbers'],
    ['With_Mixed_123_and_SPACES', 'with_mixed_123_and_spaces'],
    ['HTMLParser', 'html_parser'],
    ['HTTPResponseCode', 'http_response_code'],
    ['a_b_c', 'a_b_c'],
    ['A_B_C', 'a_b_c'],
    ['fromAtoB', 'from_ato_b'],
    ['XMLHTTPRequest', 'xmlhttp_request'],
    ['_leading', 'leading'],
    ['trailing_', 'trailing'],
    ['  leading_and_trailing_  ', 'leading_and_trailing'],
    ['Multiple___Underscores', 'multiple_underscores'],
    ['  spaces_and___underscores  ', 'spaces_and_underscores'],
    ['  _mixed_Case  ', 'mixed_case'],
    ['123Start', '123_start'],
    ['End123', 'end123'],
    ['Mid123dle', 'mid123dle'],
  ];

  it.each(cases)('converts %j to %j', (inputStr, expectedOutput) => {
    expect(toSnakeCase(inputStr)).toBe(expectedOutput);
  });
});

describe('renamePythonKeywords', () => {
  const cases: Array<[string, string]> = [
    ['in', 'param_in'],
    ['for', 'param_for'],
    ['class', 'param_class'],
    ['normal', 'normal'],
    ['param_if', 'param_if'],
    ['', ''],
  ];

  it.each(cases)('renames %j to %j', (inputStr, expectedOutput) => {
    expect(renamePythonKeywords(inputStr)).toBe(expectedOutput);
  });
});

describe('ApiParameter', () => {
  it('initializes properties and computes pyName, typeHint, and typeValue', () => {
    const schema: OpenAPIV3.SchemaObject = {
      type: 'string',
      description: 'A string parameter',
    };
    const param = new ApiParameter({
      originalName: 'testParam',
      description: 'A string description',
      paramLocation: 'query',
      paramSchema: schema,
    });

    expect(param.originalName).toBe('testParam');
    expect(param.original_name).toBe('testParam');
    expect(param.paramLocation).toBe('query');
    expect(param.param_location).toBe('query');
    expect(param.paramSchema.type).toBe('string');
    expect(param.paramSchema.description).toBe('A string parameter');
    expect(param.pyName).toBe('test_param');
    expect(param.py_name).toBe('test_param');
    expect(param.typeHint).toBe('str');
    expect(param.type_hint).toBe('str');
    expect(param.typeValue).toBe('str');
    expect(param.type_value).toBe('str');
    expect(param.description).toBe('A string description');
  });

  it('renames Python keyword parameter names', () => {
    const schema: OpenAPIV3.SchemaObject = {type: 'string'};
    const param = new ApiParameter({
      originalName: 'in',
      paramLocation: 'query',
      paramSchema: schema,
    });
    expect(param.pyName).toBe('param_in');
  });

  it('respects custom pyName', () => {
    const schema: OpenAPIV3.SchemaObject = {type: 'integer'};
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: schema,
      pyName: 'custom_name',
    });
    expect(param.pyName).toBe('custom_name');
  });

  it('formats string representation', () => {
    const schema: OpenAPIV3.SchemaObject = {type: 'number'};
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: schema,
    });
    expect(String(param)).toBe('test_param: float');
  });

  it('formats toArgString', () => {
    const schema: OpenAPIV3.SchemaObject = {type: 'boolean'};
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'query',
      paramSchema: schema,
    });
    expect(param.toArgString()).toBe('test_param=test_param');
  });

  it('formats toDictProperty', () => {
    const schema: OpenAPIV3.SchemaObject = {type: 'string'};
    const param = new ApiParameter({
      originalName: 'testParam',
      paramLocation: 'path',
      paramSchema: schema,
    });
    expect(param.toDictProperty()).toBe('"test_param": test_param');
  });

  it('serializes via modelDump / toJSON', () => {
    const schema: OpenAPIV3.SchemaObject = {
      type: 'string',
      description: 'test description',
    };
    const param = new ApiParameter({
      originalName: 'TestParam',
      paramLocation: 'path',
      paramSchema: schema,
      pyName: 'test_param_custom',
      description: 'test description',
    });

    const serializedParam = param.modelDump();
    expect(serializedParam).toEqual({
      original_name: 'TestParam',
      param_location: 'path',
      param_schema: {type: 'string', description: 'test description'},
      description: 'test description',
      py_name: 'test_param_custom',
    });
  });

  const typeCases: Array<[Record<string, unknown>, string, string]> = [
    [{type: 'integer'}, 'int', 'int'],
    [{type: 'number'}, 'float', 'float'],
    [{type: 'boolean'}, 'bool', 'bool'],
    [{type: 'string'}, 'str', 'str'],
    [{type: 'string', format: 'date'}, 'str', 'str'],
    [{type: 'string', format: 'date-time'}, 'str', 'str'],
    [{type: 'array', items: {type: 'integer'}}, 'List[int]', 'List[int]'],
    [{type: 'array', items: {type: 'string'}}, 'List[str]', 'List[str]'],
    [
      {type: 'array', items: {type: 'object'}},
      'List[Dict[str, Any]]',
      'List[Dict[str, Any]]',
    ],
    [{type: 'object'}, 'Dict[str, Any]', 'Dict[str, Any]'],
    [{type: 'unknown'}, 'Any', 'Any'],
    [{}, 'Any', 'Any'],
  ];

  it.each(typeCases)(
    'computes typeValue and typeHint for schema %j',
    (schema, expectedTypeValue, expectedTypeHint) => {
      const param = new ApiParameter({
        originalName: 'test',
        paramLocation: 'query',
        paramSchema: schema,
      });
      expect(param.typeValue).toBe(expectedTypeValue);
      expect(param.typeHint).toBe(expectedTypeHint);
      expect(TypeHintHelper.getTypeHint(param.paramSchema)).toBe(
        expectedTypeHint,
      );
      expect(TypeHintHelper.getTypeValue(param.paramSchema)).toBe(
        expectedTypeValue,
      );
    },
  );

  it('uses explicit description when provided', () => {
    const schema: OpenAPIV3.SchemaObject = {type: 'string'};
    const param = new ApiParameter({
      originalName: 'param1',
      paramLocation: 'query',
      paramSchema: schema,
      description: 'The description',
    });
    expect(param.description).toBe('The description');
  });

  it('falls back to schema description when explicit description is omitted', () => {
    const schema: OpenAPIV3.SchemaObject = {
      type: 'string',
      description: 'The description',
    };
    const param = new ApiParameter({
      originalName: 'param1',
      paramLocation: 'query',
      paramSchema: schema,
    });
    expect(param.description).toBe('The description');
  });
});

describe('TypeHintHelper', () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{type: 'integer'}, 'int', 'int'],
    [{type: 'number'}, 'float', 'float'],
    [{type: 'string'}, 'str', 'str'],
    [{type: 'array', items: {type: 'string'}}, 'List[str]', 'List[str]'],
  ];

  it.each(cases)(
    'returns typeValue and typeHint for %j',
    (schema, expectedTypeValue, expectedTypeHint) => {
      const param = new ApiParameter({
        originalName: 'test_param',
        paramLocation: 'query',
        paramSchema: schema,
        description: 'Test parameter',
      });
      expect(TypeHintHelper.getTypeValue(param.paramSchema)).toBe(
        expectedTypeValue,
      );
      expect(TypeHintHelper.getTypeHint(param.paramSchema)).toBe(
        expectedTypeHint,
      );
    },
  );
});

describe('PydocHelper', () => {
  it('generates simple param doc', () => {
    const param = new ApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {type: 'string'},
      description: 'Test description',
    });
    expect(PydocHelper.generateParamDoc(param)).toBe(
      'test_param (str): Test description',
    );
  });

  it('generates param doc with no description', () => {
    const param = new ApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {type: 'integer'},
    });
    expect(PydocHelper.generateParamDoc(param)).toBe('test_param (int): ');
  });

  it('generates param doc for object with properties', () => {
    const param = new ApiParameter({
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
    const expectedDoc =
      'test_param (Dict[str, Any]): Test object parameter Object' +
      ' properties:\n       prop1 (str): Prop1 desc\n       prop2' +
      ' (int): \n';
    expect(PydocHelper.generateParamDoc(param)).toBe(expectedDoc);
  });

  it('generates param doc for object with no properties', () => {
    const param = new ApiParameter({
      originalName: 'test_param',
      paramLocation: 'query',
      paramSchema: {type: 'object', description: 'A test schema'},
      description: 'The description.',
    });
    expect(PydocHelper.generateParamDoc(param)).toBe(
      'test_param (Dict[str, Any]): The description.',
    );
  });

  it('generates simple return doc', () => {
    const responses = {
      '200': {
        description: 'Successful response',
        content: {'application/json': {schema: {type: 'string' as const}}},
      },
    };
    expect(PydocHelper.generateReturnDoc(responses)).toBe(
      'Returns (str): Successful response',
    );
  });

  it('returns empty string when response has no content', () => {
    const responses = {'204': {description: 'No content'}};
    expect(PydocHelper.generateReturnDoc(responses)).toBe('');
  });

  it('generates return doc for object response', () => {
    const responses = {
      '200': {
        description: 'Successful object response',
        content: {
          'application/json': {
            schema: {
              type: 'object' as const,
              properties: {
                prop1: {type: 'string' as const, description: 'Prop1 desc'},
                prop2: {type: 'integer' as const},
              },
            },
          },
        },
      },
    };

    const returnDoc = PydocHelper.generateReturnDoc(responses);
    expect(returnDoc).toContain(
      'Returns (Dict[str, Any]): Successful object response',
    );
    expect(returnDoc).toContain('prop1 (str): Prop1 desc');
    expect(returnDoc).toContain('prop2 (int):');
  });

  it('generates return doc when multiple status codes exist', () => {
    const responses = {
      '200': {
        description: 'Successful response',
        content: {'application/json': {schema: {type: 'string' as const}}},
      },
      '400': {description: 'Bad request'},
    };
    expect(PydocHelper.generateReturnDoc(responses)).toBe(
      'Returns (str): Successful response',
    );
  });

  it('selects the smallest 2xx status code response', () => {
    const responses = {
      '201': {
        description: '201 response',
        content: {'application/json': {schema: {type: 'integer' as const}}},
      },
      '200': {
        description: '200 response',
        content: {'application/json': {schema: {type: 'string' as const}}},
      },
      '400': {description: 'Bad request'},
    };
    expect(PydocHelper.generateReturnDoc(responses)).toBe(
      'Returns (str): 200 response',
    );
  });

  it('selects the first contentful 2xx response', () => {
    const responses = {
      '200': {description: 'No content response'},
      '201': {
        description: '201 response',
        content: {'application/json': {schema: {type: 'string' as const}}},
      },
      '400': {description: 'Bad request'},
    };
    expect(PydocHelper.generateReturnDoc(responses)).toBe(
      'Returns (str): 201 response',
    );
  });
});
