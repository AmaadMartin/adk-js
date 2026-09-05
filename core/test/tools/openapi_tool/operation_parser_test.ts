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
});

describe('OperationParser naming', () => {
  function parseWithParameter(name: string): string {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      parameters: [{name, in: 'query', schema: {type: 'string'}}],
      responses: {},
    };
    return new OperationParser(op).getParameters()[0].name;
  }

  it.each([
    ['petId', 'pet_id'],
    ['X-Trace-Id', 'x_trace_id'],
    ['RESTApiCall', 'rest_api_call'],
    ['already_snake', 'already_snake'],
  ])('should name the parameter %s as %s', (original, expected) => {
    expect(parseWithParameter(original)).toBe(expected);
  });

  it('should keep the original parameter name when asked to preserve it', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      parameters: [
        {name: 'X-Trace-Id', in: 'header', schema: {type: 'string'}},
      ],
      responses: {},
    };

    const parser = new OperationParser(op, {preservePropertyNames: true});

    expect(parser.getParameters()[0].name).toBe('X-Trace-Id');
  });

  it.each([
    ['findPetsByStatus', 'find_pets_by_status'],
    ['RESTApiCall', 'rest_api_call'],
  ])('should name the function for %s as %s', (operationId, expected) => {
    const op: OpenAPIV3.OperationObject = {operationId, responses: {}};

    expect(new OperationParser(op).getFunctionName()).toBe(expected);
  });

  it('should keep the operation id when asked to preserve names', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'RESTApiCall',
      responses: {},
    };

    const parser = new OperationParser(op, {preservePropertyNames: true});

    expect(parser.getFunctionName()).toBe('RESTApiCall');
  });

  it('should name a request body property', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {petName: {type: 'string'}},
              required: ['petName'],
            },
          },
        },
      },
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params[0].name).toBe('pet_name');
    expect(params[0].required).toBe(true);
  });

  it('should treat a parameter with no schema as unconstrained', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      parameters: [{name: 'petId', in: 'query'}],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params[0].paramSchema).toEqual({});
  });

  it('should treat a boolean parameter schema as unconstrained', () => {
    // JSON Schema allows a boolean where OpenAPI 3.0's typings require an
    // object, and a parsed document can carry one.
    const booleanSchema = true as unknown as OpenAPIV3.SchemaObject;
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      parameters: [{name: 'petId', in: 'query', schema: booleanSchema}],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params[0].name).toBe('pet_id');
    expect(params[0].paramSchema).toEqual({});
  });

  it('should keep every parameter when one schema is a dangling reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'testOp',
      parameters: [
        {name: 'broken', in: 'query', schema: {$ref: '#/components/x'}},
        {name: 'petId', in: 'query', schema: {type: 'string'}},
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params.map((param) => param.name)).toEqual(['broken', 'pet_id']);
    expect(params[0].paramSchema).toEqual({});
  });
});
