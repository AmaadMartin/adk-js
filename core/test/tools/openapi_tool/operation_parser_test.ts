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

  it('should number colliding parameter names from 0', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [
        {name: 'x_api_key', in: 'query'},
        {name: 'xApiKey', in: 'header'},
        {name: 'XApiKey', in: 'cookie'},
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params.map((p) => p.name)).toEqual([
      'x_api_key',
      'x_api_key_0',
      'x_api_key_1',
    ]);
    expect(params.map((p) => p.originalName)).toEqual([
      'x_api_key',
      'xApiKey',
      'XApiKey',
    ]);
  });

  it('should expose the deduped names in the generated schema', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [
        {name: 'x_api_key', in: 'query'},
        {name: 'xApiKey', in: 'header'},
        {name: 'XApiKey', in: 'cookie'},
      ],
      responses: {},
    };

    const schema = new OperationParser(op).getJsonSchema();

    expect(schema.properties).toEqual({
      x_api_key: {},
      x_api_key_0: {},
      x_api_key_1: {},
    });
  });

  it('should number each colliding name independently', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [
        {name: 'pet_id', in: 'path'},
        {name: 'petId', in: 'query'},
        {name: 'x_api_key', in: 'query'},
        {name: 'xApiKey', in: 'header'},
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params.map((p) => p.name)).toEqual([
      'pet_id',
      'pet_id_0',
      'x_api_key',
      'x_api_key_0',
    ]);
  });

  it('should leave distinct parameter names unsuffixed', () => {
    const op: OpenAPIV3.OperationObject = {
      operationId: 'getPet',
      parameters: [
        {name: 'pet_id', in: 'path'},
        {name: 'x_api_key', in: 'header'},
      ],
      responses: {},
    };

    const params = new OperationParser(op).getParameters();

    expect(params.map((p) => p.name)).toEqual(['pet_id', 'x_api_key']);
  });
});
