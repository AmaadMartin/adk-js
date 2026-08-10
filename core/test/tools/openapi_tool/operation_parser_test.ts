/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OperationParser} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

/** Reads the argument properties out of a parser's generated JSON schema. */
function properties(
  parser: OperationParser,
): Record<string, OpenAPIV3.SchemaObject> {
  return parser.getJsonSchema()['properties'] as Record<
    string,
    OpenAPIV3.SchemaObject
  >;
}

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

  it('should copy a parameter description onto its schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'findPetsByStatus',
      parameters: [
        {
          name: 'status',
          in: 'query',
          description: 'Status filter',
          schema: {type: 'string'},
        },
      ],
      responses: {},
    };

    const parser = new OperationParser(op);

    expect(properties(parser)['status']).toEqual({
      type: 'string',
      description: 'Status filter',
    });
    expect(parser.getParameters()[0].paramSchema.description).toBe(
      'Status filter',
    );
  });

  it('should keep a schema description over the parameter description', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'findPetsByStatus',
      parameters: [
        {
          name: 'status',
          in: 'query',
          description: 'Parameter loses',
          schema: {type: 'string', description: 'Schema wins'},
        },
      ],
      responses: {},
    };

    const parser = new OperationParser(op);

    expect(properties(parser)['status']).toEqual({
      type: 'string',
      description: 'Schema wins',
    });
    expect(parser.getParameters()[0].description).toBe('Parameter loses');
  });

  it('should build a schema from the description of a schemaless parameter', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [{name: 'token', in: 'header', description: 'Auth token'}],
      responses: {},
    };

    const parser = new OperationParser(op);

    expect(properties(parser)['token']).toEqual({description: 'Auth token'});
  });

  it('should leave an undocumented parameter schema untouched', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listPets',
      parameters: [{name: 'limit', in: 'query', schema: {type: 'integer'}}],
      responses: {},
    };

    const parser = new OperationParser(op);

    expect(properties(parser)['limit']).toEqual({type: 'integer'});
  });

  it('should keep the description of a request body property', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'addPet',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {name: {type: 'string', description: 'Pet name'}},
            },
          },
        },
      },
      responses: {},
    };

    const parser = new OperationParser(op);

    expect(properties(parser)['name']).toEqual({
      type: 'string',
      description: 'Pet name',
    });
  });

  it('should not mutate the schema of the operation it parses', () => {
    const paramSchema: OpenAPIV3.SchemaObject = {type: 'string'};
    const op: OpenAPIV3.OperationObject = {
      operationId: 'findPetsByStatus',
      parameters: [
        {
          name: 'status',
          in: 'query',
          description: 'Status filter',
          schema: paramSchema,
        },
      ],
      responses: {},
    };

    new OperationParser(op);

    expect(paramSchema).toEqual({type: 'string'});
  });
});
