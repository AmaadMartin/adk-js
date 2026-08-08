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

describe('OperationParser default argument name when the derived name is empty', () => {
  function parseOneParameter(
    parameter: OpenAPIV3.ParameterObject,
    options: {preservePropertyNames?: boolean} = {},
  ): ApiParameter {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listThings',
      parameters: [parameter],
      responses: {},
    };
    return new OperationParser(op, options).getParameters()[0];
  }

  it.each([
    ['body', 'body'],
    ['query', 'query_param'],
    ['path', 'path_param'],
    ['header', 'header_param'],
    ['cookie', 'cookie_param'],
  ])('should name an empty %s parameter %s', (location, expected) => {
    expect(parseOneParameter({name: '', in: location}).name).toBe(expected);
  });

  it.each([[''], ['somewhere']])(
    'should fall back to value for the unknown location %o',
    (location) => {
      expect(parseOneParameter({name: '', in: location}).name).toBe('value');
    },
  );

  it('should fall back to value for a location that names an Object member', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listThings',
      parameters: [
        {name: '', in: '__proto__'},
        {name: '', in: 'constructor'},
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params.map((p) => typeof p.name)).toEqual(['string', 'string']);
    expect(params.map((p) => p.name)).toEqual(['value', 'value_1']);
  });

  it('should keep the original name of an empty parameter empty', () => {
    expect(parseOneParameter({name: '', in: 'query'}).originalName).toBe('');
  });

  it('should leave a non-empty parameter name alone', () => {
    expect(parseOneParameter({name: 'userId', in: 'query'}).name).toBe(
      'user_id',
    );
  });

  it('should dedupe two empty parameters in the same location', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listThings',
      parameters: [
        {name: '', in: 'query'},
        {name: '', in: 'query'},
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    // The _1 suffix is the current dedupe behaviour; adk-python numbers from 0
    // and that divergence is tracked separately.
    expect(params.map((p) => p.name)).toEqual(['query_param', 'query_param_1']);
  });

  it('should fall back with preservePropertyNames set', () => {
    expect(
      parseOneParameter({name: '', in: 'query'}, {preservePropertyNames: true})
        .name,
    ).toBe('query_param');
  });

  it('should name an empty request body property body', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'createThing',
      requestBody: {
        content: {
          'application/json': {
            schema: {type: 'object', properties: {'': {type: 'string'}}},
          },
        },
      },
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params.map((p) => p.name)).toEqual(['body']);
    expect(params[0].paramLocation).toBe('body');
    expect(params[0].originalName).toBe('');
  });

  it('should key the json schema by the default name', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listThings',
      parameters: [{name: '', in: 'query', required: true}],
      responses: {},
    };

    const schema = new OperationParser(op).getJsonSchema();

    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual([
      'query_param',
    ]);
    expect(schema.required).toEqual(['query_param']);
  });
});
