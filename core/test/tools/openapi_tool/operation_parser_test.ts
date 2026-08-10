/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OperationParser} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

function operationWithBody(
  schema: OpenAPIV3.SchemaObject,
): OpenAPIV3.OperationObject {
  return {
    operationId: 'testOp',
    requestBody: {content: {'application/json': {schema}}},
    responses: {},
  };
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
    expect(params[0].name).toBe('array');
    expect(params[0].originalName).toBe('array');
    expect(params[0].paramLocation).toBe('body');
    expect(params[0].paramSchema.type).toBe('array');
  });

  it("should key the json schema for an array request body on 'array'", () => {
    const schema = new OperationParser(
      operationWithBody({type: 'array', items: {type: 'string'}}),
    ).getJsonSchema();

    expect(schema.properties).toEqual({
      array: {type: 'array', items: {type: 'string'}},
    });
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

  it('should emit no argument for an empty object request body', () => {
    const parser = new OperationParser(
      operationWithBody({type: 'object', properties: {}}),
    );

    expect(parser.getParameters()).toEqual([]);
    expect(parser.getJsonSchema().properties).toEqual({});
  });

  it('should emit no argument for an object request body with no properties key', () => {
    const parser = new OperationParser(operationWithBody({type: 'object'}));

    expect(parser.getParameters()).toEqual([]);
    expect(parser.getJsonSchema().properties).toEqual({});
  });

  it('should name a oneOf request body argument body', () => {
    const parser = new OperationParser(
      operationWithBody({
        oneOf: [{type: 'object', properties: {stage: {type: 'string'}}}],
      }),
    );
    const params = parser.getParameters();

    expect(params.length).toBe(1);
    expect(params[0].name).toBe('body');
    expect(params[0].paramLocation).toBe('body');
  });

  it('should name an untyped request body argument body', () => {
    const parser = new OperationParser(
      operationWithBody({description: 'anything goes'}),
    );
    const params = parser.getParameters();

    expect(params.length).toBe(1);
    expect(params[0].name).toBe('body');
    expect(params[0].paramLocation).toBe('body');
  });

  it('should emit one argument per property of an object request body', () => {
    const parser = new OperationParser(
      operationWithBody({
        type: 'object',
        properties: {itemName: {type: 'string'}, count: {type: 'integer'}},
        required: ['itemName'],
      }),
    );
    const params = parser.getParameters();

    expect(params.map((p) => p.name)).toEqual(['item_name', 'count']);
    expect(params.map((p) => p.required)).toEqual([true, false]);
    expect(parser.getJsonSchema().properties).toEqual({
      item_name: {type: 'string'},
      count: {type: 'integer'},
    });
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
