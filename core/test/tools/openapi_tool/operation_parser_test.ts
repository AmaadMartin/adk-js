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

  it('should expose the 2xx response schema via getReturnValue', () => {
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

    const returnValue = new OperationParser(op).getReturnValue();

    expect(returnValue.paramSchema.type).toBe('object');
    expect(returnValue.paramSchema.properties?.['id']).toBeDefined();
    expect(returnValue.name).toBe('return');
    expect(returnValue.required).toBe(true);
    expect(returnValue.originalName).toBe('');
    expect(returnValue.paramLocation).toBe('');
  });

  it('should pick the lowest 2xx response code when several are declared', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      responses: {
        '201': {
          description: 'Created',
          content: {'application/json': {schema: {type: 'integer'}}},
        },
        '202': {
          description: 'Accepted',
          content: {'application/json': {schema: {type: 'string'}}},
        },
        '200': {
          description: 'OK',
          content: {'application/json': {schema: {type: 'boolean'}}},
        },
        '400': {
          description: 'Client Error',
          content: {'application/json': {schema: {type: 'object'}}},
        },
      },
    };

    const returnValue = new OperationParser(op).getReturnValue();

    expect(returnValue.paramSchema.type).toBe('boolean');
  });

  it('should return an empty schema when no 2xx response is declared', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      responses: {'400': {description: 'Client Error'}},
    };

    const returnValue = new OperationParser(op).getReturnValue();

    expect(returnValue.paramSchema).toEqual({});
    expect(returnValue.name).toBe('return');
  });

  it('should return an empty schema when the 2xx response has no content', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      responses: {'200': {description: 'Success'}},
    };

    expect(new OperationParser(op).getReturnValue().paramSchema).toEqual({});
  });

  it('should return an empty schema when the 2xx content declares no schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      responses: {
        '200': {description: 'Success', content: {'application/json': {}}},
      },
    };

    expect(new OperationParser(op).getReturnValue().paramSchema).toEqual({});
  });

  it('should return an empty schema for an operation with no responses', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      responses: {},
    };

    const returnValue = new OperationParser(op).getReturnValue();

    expect(returnValue).toBeDefined();
    expect(returnValue.paramSchema).toEqual({});
  });
});
