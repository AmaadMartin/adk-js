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

describe('OperationParser.getDocString', () => {
  it('should render the summary, the arguments and the return value', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      summary: 'Get a pet by id',
      parameters: [
        {
          name: 'petId',
          in: 'path',
          description: 'The pet id',
          required: true,
          schema: {type: 'integer'},
        },
      ],
      responses: {
        '200': {
          description: 'The pet name',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      },
    };

    const docString = new OperationParser(op).getDocString();

    expect(docString).toContain('Get a pet by id');
    expect(docString).toContain('Args:');
    expect(docString).toContain('    pet_id (number): The pet id');
    expect(docString).toContain('Returns (string): The pet name');
  });

  it('should fall back to the description when there is no summary', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      description: 'Fetches one pet',
      responses: {},
    };

    expect(new OperationParser(op).getDocString()).toContain('Fetches one pet');
  });

  it('should render an operation with no summary and no arguments', () => {
    const op: OpenAPIV3.OperationObject = {operationId: 'ping', responses: {}};

    expect(new OperationParser(op).getDocString()).toBe('\n\nArgs:\n\n\n');
  });
});

describe('OperationParser schema normalization', () => {
  it('should reject a parameter schema that is an unresolved reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [
        {name: 'petId', in: 'path', schema: {$ref: '#/components/schemas/Id'}},
      ],
      responses: {},
    };

    expect(() => new OperationParser(op)).toThrow(
      "operation parameter 'petId' contains unresolved reference" +
        " '#/components/schemas/Id'",
    );
  });

  it('should reject a body property that is an unresolved reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'createPet',
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {pet: {$ref: '#/components/schemas/Pet'}},
            },
          },
        },
      },
      responses: {},
    };

    expect(() => new OperationParser(op)).toThrow(
      "request body property 'pet' contains unresolved reference" +
        " '#/components/schemas/Pet'",
    );
  });

  it('should reject a response schema that is an unresolved reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      responses: {
        '200': {
          description: 'OK',
          content: {
            'application/json': {schema: {$ref: '#/components/schemas/Pet'}},
          },
        },
      },
    };

    expect(() => new OperationParser(op)).toThrow(
      "response '200' body contains unresolved reference" +
        " '#/components/schemas/Pet'",
    );
  });

  it('should skip a parameter that is itself a reference', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listPets',
      parameters: [
        {$ref: '#/components/parameters/Missing'},
        {name: 'limit', in: 'query', schema: {type: 'integer'}},
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params.length).toBe(1);
    expect(params[0].name).toBe('limit');
  });

  it('should take the parameter description from its schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listPets',
      parameters: [
        {
          name: 'limit',
          in: 'query',
          schema: {type: 'integer', description: 'How many pets'},
        },
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params[0].description).toBe('How many pets');
  });

  it('should copy the parameter description onto its schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listPets',
      parameters: [
        {
          name: 'limit',
          in: 'query',
          description: 'How many pets',
          schema: {type: 'integer'},
        },
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params[0].paramSchema).toEqual({
      type: 'integer',
      description: 'How many pets',
    });
  });

  it('should keep the schema description over the parameter one', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listPets',
      parameters: [
        {
          name: 'limit',
          in: 'query',
          description: 'Parameter description',
          schema: {type: 'integer', description: 'Schema description'},
        },
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params[0].paramSchema).toEqual({
      type: 'integer',
      description: 'Schema description',
    });
  });

  it('should name an unnamed parameter after its location', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'listPets',
      parameters: [{name: '', in: 'query', schema: {type: 'string'}}],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params[0].name).toBe('query_param');
  });
});
