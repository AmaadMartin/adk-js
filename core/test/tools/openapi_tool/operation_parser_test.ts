/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OperationParser} from '@google/adk';
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

  it.each([
    ['REST API', 'rest_api'],
    ['user-id', 'user_id'],
    ['UpperCamelCase', 'upper_camel_case'],
  ])('should derive the parameter name %s as %s', (original, expected) => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      parameters: [{name: original, in: 'query', schema: {type: 'string'}}],
      responses: {},
    };

    const parser = new OperationParser(op);

    expect(parser.getParameters()[0].name).toBe(expected);
  });

  it('should rename a parameter named after a reserved word', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      parameters: [{name: 'in', in: 'query', schema: {type: 'string'}}],
      responses: {},
    };

    const parser = new OperationParser(op);

    expect(parser.getParameters()[0].name).toBe('param_in');
  });

  it('should keep the original parameter name when asked to', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      parameters: [{name: 'REST API', in: 'query', schema: {type: 'string'}}],
      responses: {},
    };

    const parser = new OperationParser(op, {preservePropertyNames: true});

    expect(parser.getParameters()[0].name).toBe('REST API');
  });
});
