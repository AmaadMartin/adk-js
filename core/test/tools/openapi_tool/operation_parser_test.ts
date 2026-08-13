/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OperationParser} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

const ARRAY_SCHEMA: OpenAPIV3.SchemaObject = {
  type: 'array',
  items: {type: 'string'},
};

const ONE_OF_SCHEMA: OpenAPIV3.SchemaObject = {
  oneOf: [{type: 'string'}, {type: 'integer'}],
};

const EMPTY_OBJECT_SCHEMA: OpenAPIV3.SchemaObject = {
  type: 'object',
  properties: {},
};

function operationWithBody(
  schema: OpenAPIV3.SchemaObject,
  requestBody: Partial<OpenAPIV3.RequestBodyObject> = {},
): OpenAPIV3.OperationObject {
  return {
    operationId: 'testOp',
    requestBody: {...requestBody, content: {'application/json': {schema}}},
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

  it('array request body is required when requestBody.required is true', () => {
    const parser = new OperationParser(
      operationWithBody(ARRAY_SCHEMA, {required: true}),
    );

    expect(parser.getParameters()[0].required).toBe(true);
  });

  it('array request body is optional when requestBody.required is false', () => {
    const parser = new OperationParser(
      operationWithBody(ARRAY_SCHEMA, {required: false}),
    );

    expect(parser.getParameters()[0].required).toBe(false);
  });

  it('array request body is optional when requestBody.required is omitted', () => {
    const parser = new OperationParser(operationWithBody(ARRAY_SCHEMA));

    expect(parser.getParameters()[0].required).toBe(false);
  });

  it('scalar request body is listed as required when requestBody.required is true', () => {
    const parser = new OperationParser(
      operationWithBody({type: 'string'}, {required: true}),
    );

    expect(parser.getJsonSchema().required).toEqual(['body']);
  });

  it('scalar request body is not listed as required when requestBody.required is omitted', () => {
    const parser = new OperationParser(operationWithBody({type: 'string'}));

    expect(parser.getJsonSchema().required).toBeUndefined();
  });

  it('oneOf request body is required when requestBody.required is true', () => {
    const parser = new OperationParser(
      operationWithBody(ONE_OF_SCHEMA, {required: true}),
    );

    expect(parser.getParameters()[0].required).toBe(true);
  });

  it('oneOf request body is optional when requestBody.required is omitted', () => {
    const parser = new OperationParser(operationWithBody(ONE_OF_SCHEMA));

    expect(parser.getParameters()[0].required).toBe(false);
  });

  it('empty object request body is required when requestBody.required is true', () => {
    const parser = new OperationParser(
      operationWithBody(EMPTY_OBJECT_SCHEMA, {required: true}),
    );

    expect(parser.getParameters()[0].required).toBe(true);
  });

  it('empty object request body is optional when requestBody.required is omitted', () => {
    const parser = new OperationParser(operationWithBody(EMPTY_OBJECT_SCHEMA));

    expect(parser.getParameters()[0].required).toBe(false);
  });

  it('object request body properties keep deriving required from the body schema', () => {
    const parser = new OperationParser(
      operationWithBody(
        {
          type: 'object',
          required: ['spaceName'],
          properties: {
            spaceName: {type: 'string'},
            description: {type: 'string'},
          },
        },
        {required: true},
      ),
    );

    expect(parser.getJsonSchema().required).toEqual(['space_name']);
  });
});
