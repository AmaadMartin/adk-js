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

  it('should use the first 2xx media type that declares a schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {
        '200': {
          description: 'OK',
          content: {
            'text/plain': {},
            'application/json': {
              schema: {type: 'object', properties: {id: {type: 'integer'}}},
            },
          },
        },
      },
    };

    const returnValue = new OperationParser(op).getReturnValue();

    expect(returnValue?.paramSchema.type).toBe('object');
    expect(returnValue?.paramSchema.properties?.['id']).toBeDefined();
  });

  it('should keep an empty return schema when no media type declares a schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {
        '200': {
          description: 'OK',
          content: {'text/plain': {}, 'application/xml': {}},
        },
      },
    };

    const returnValue = new OperationParser(op).getReturnValue();

    expect(returnValue?.paramSchema).toEqual({});
    expect(returnValue?.name).toBe('return');
  });

  it('should scan the media types of the lowest 2xx response only', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {
        '201': {
          description: 'Created',
          content: {'application/json': {schema: {type: 'string'}}},
        },
        '200': {
          description: 'OK',
          content: {
            'text/plain': {},
            'application/json': {schema: {type: 'boolean'}},
          },
        },
      },
    };

    const returnValue = new OperationParser(op).getReturnValue();

    expect(returnValue?.paramSchema.type).toBe('boolean');
  });

  it('should skip a media type whose schema is an unresolved reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': {schema: {$ref: '#/components/schemas/Pet'}},
            'application/xml': {schema: {type: 'string'}},
          },
        },
      },
    };

    const returnValue = new OperationParser(op).getReturnValue();

    expect(returnValue?.paramSchema.type).toBe('string');
  });
});
