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

  describe('parameter descriptions', () => {
    function operationWithParameter(
      parameter: OpenAPIV3.ParameterObject,
    ): OpenAPIV3.OperationObject {
      return {operationId: 'testOp', parameters: [parameter], responses: {}};
    }

    it('should advertise the parameter description on a schema that has none', () => {
      const parser = new OperationParser(
        operationWithParameter({
          name: 'param1',
          in: 'query',
          description: 'Parameter 1',
          schema: {type: 'string'},
        }),
      );

      expect(parser.getJsonSchema().properties).toEqual({
        param1: {type: 'string', description: 'Parameter 1'},
      });
      expect(parser.getParameters()[0].description).toBe('Parameter 1');
    });

    it('should keep a description the schema already declares', () => {
      const parser = new OperationParser(
        operationWithParameter({
          name: 'param1',
          in: 'query',
          description: 'Parameter 1',
          schema: {type: 'string', description: 'Schema 1'},
        }),
      );

      expect(parser.getJsonSchema().properties).toEqual({
        param1: {type: 'string', description: 'Schema 1'},
      });
      expect(parser.getParameters()[0].description).toBe('Parameter 1');
    });

    it('should fall back to the schema description', () => {
      const parser = new OperationParser(
        operationWithParameter({
          name: 'param1',
          in: 'query',
          schema: {type: 'string', description: 'Schema 1'},
        }),
      );

      expect(parser.getParameters()[0].description).toBe('Schema 1');
    });

    it('should emit no description when neither declares one', () => {
      const parser = new OperationParser(
        operationWithParameter({
          name: 'param1',
          in: 'query',
          schema: {type: 'string'},
        }),
      );

      expect(parser.getJsonSchema().properties).toEqual({
        param1: {type: 'string'},
      });
      expect(parser.getParameters()[0].description).toBe('');
    });

    it('should describe a parameter that declares no schema', () => {
      const parser = new OperationParser(
        operationWithParameter({
          name: 'param1',
          in: 'query',
          description: 'Parameter 1',
        }),
      );

      expect(parser.getJsonSchema().properties).toEqual({
        param1: {description: 'Parameter 1'},
      });
    });

    it('should leave the operation schema unchanged', () => {
      const schema: OpenAPIV3.SchemaObject = {type: 'string'};
      new OperationParser(
        operationWithParameter({
          name: 'param1',
          in: 'query',
          description: 'Parameter 1',
          schema,
        }),
      );

      expect(schema.description).toBeUndefined();
    });
  });

  describe('request body descriptions', () => {
    function operationWithBody(
      schema: OpenAPIV3.SchemaObject,
      description?: string,
    ): OpenAPIV3.OperationObject {
      return {
        operationId: 'testOp',
        requestBody: {description, content: {'application/json': {schema}}},
        responses: {},
      };
    }

    it('should keep the description of a body property', () => {
      const parser = new OperationParser(
        operationWithBody({
          type: 'object',
          properties: {prop1: {type: 'string', description: 'Property 1'}},
        }),
      );

      expect(parser.getParameters()[0].description).toBe('Property 1');
      expect(parser.getJsonSchema().properties).toEqual({
        prop1: {type: 'string', description: 'Property 1'},
      });
    });

    it('should describe a body property that declares nothing as an empty string', () => {
      const parser = new OperationParser(
        operationWithBody({
          type: 'object',
          properties: {prop1: {type: 'string'}},
        }),
      );

      expect(parser.getParameters()[0].description).toBe('');
    });

    it('should fall back to the body schema description', () => {
      const parser = new OperationParser(
        operationWithBody({type: 'string', description: 'Schema body'}),
      );

      expect(parser.getParameters()[0].description).toBe('Schema body');
    });

    it('should prefer the request body description', () => {
      const parser = new OperationParser(
        operationWithBody(
          {type: 'string', description: 'Schema body'},
          'Request body',
        ),
      );

      expect(parser.getParameters()[0].description).toBe('Request body');
    });
  });
  describe('getJsonSchema encoding', () => {
    function operationWithQuerySchema(
      schema: OpenAPIV3.SchemaObject,
    ): OpenAPIV3.OperationObject {
      return {
        operationId: 'testOp',
        parameters: [{name: 'param1', in: 'query', schema}],
        responses: {},
      };
    }

    it('should drop undefined schema members and keep the declared null ones', () => {
      const parser = new OperationParser(
        operationWithQuerySchema({
          type: 'object',
          example: undefined,
          properties: {inner: {type: 'string', default: null}},
        }),
      );

      expect(parser.getJsonSchema().properties).toStrictEqual({
        param1: {
          type: 'object',
          properties: {inner: {type: 'string', default: null}},
        },
      });
    });

    it('should deep-copy the schema instead of aliasing the operation', () => {
      const schema: OpenAPIV3.SchemaObject = {
        type: 'object',
        properties: {inner: {type: 'string', description: 'Inner'}},
      };
      const parser = new OperationParser(operationWithQuerySchema(schema));

      const jsonSchema = parser.getJsonSchema();
      schema.properties = {inner: {type: 'string', description: 'Mutated'}};

      expect(jsonSchema.properties).toEqual({
        param1: {
          type: 'object',
          properties: {inner: {type: 'string', description: 'Inner'}},
        },
      });
    });

    it('should copy the members of an array schema', () => {
      const items: OpenAPIV3.SchemaObject = {type: 'string'};
      const parser = new OperationParser(
        operationWithQuerySchema({type: 'array', items, enum: ['a', 'b']}),
      );

      const jsonSchema = parser.getJsonSchema();
      items.type = 'integer';

      expect(jsonSchema.properties).toEqual({
        param1: {type: 'array', items: {type: 'string'}, enum: ['a', 'b']},
      });
    });
  });
});
