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
    expect(params[0].name).toBe('array');
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
    expect(params[0].originalName).toBe('');
    expect(params[0].required).toBe(false);
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

/** Mirrors the `sample_operation` fixture of adk-python's parser tests. */
function sampleOperation(): OpenAPIV3.OperationObject {
  return {
    operationId: 'test_operation',
    summary: 'Test Summary',
    description: 'Test Description',
    parameters: [
      {
        name: 'param1',
        in: 'query',
        schema: {type: 'string'},
        description: 'Parameter 1',
      },
      {
        name: 'param2',
        in: 'header',
        schema: {type: 'string'},
        description: 'Parameter 2',
      },
    ],
    requestBody: {
      description: 'Request body description',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              prop1: {type: 'string', description: 'Property 1'},
              prop2: {type: 'integer', description: 'Property 2'},
            },
          },
        },
      },
    },
    responses: {
      '200': {
        description: 'Success',
        content: {'application/json': {schema: {type: 'string'}}},
      },
      '400': {description: 'Client Error'},
    },
    security: [{oauth2: ['resource: read', 'resource: write']}],
  };
}

/** Builds an operation whose only content is the given request body schema. */
function operationWithBody(
  schema: OpenAPIV3.SchemaObject,
): OpenAPIV3.OperationObject {
  return {
    operationId: 'testOp',
    requestBody: {content: {'application/json': {schema}}},
    responses: {},
  };
}

describe('OperationParser parity with adk-python', () => {
  describe('parsing', () => {
    it('should parse every parameter and the return value', () => {
      const parser = new OperationParser(sampleOperation());

      expect(parser.getParameters().length).toBe(4);
      expect(parser.getReturnValue()).toBeDefined();
    });

    it('should record the location of each operation parameter', () => {
      const params = new OperationParser(sampleOperation()).getParameters();

      expect(params[0].originalName).toBe('param1');
      expect(params[0].paramLocation).toBe('query');
      expect(params[1].originalName).toBe('param2');
      expect(params[1].paramLocation).toBe('header');
    });

    it('should turn each request body property into a parameter', () => {
      const params = new OperationParser(sampleOperation()).getParameters();

      expect(params[2].originalName).toBe('prop1');
      expect(params[2].paramLocation).toBe('body');
      expect(params[3].originalName).toBe('prop2');
      expect(params[3].paramLocation).toBe('body');
    });

    it('should require the body properties the schema requires', () => {
      const parser = new OperationParser({
        operationId: 'createSpace',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['spaceName'],
                properties: {
                  spaceName: {type: 'string'},
                  description: {type: 'string'},
                },
              },
            },
          },
        },
        responses: {},
      });

      expect(parser.getJsonSchema().required).toEqual(['space_name']);
    });

    it('should name an array request body array', () => {
      const params = new OperationParser(
        operationWithBody({
          type: 'array',
          items: {type: 'object', properties: {name: {type: 'string'}}},
        }),
      ).getParameters();

      expect(params.length).toBe(1);
      expect(params[0].originalName).toBe('array');
      expect(params[0].name).toBe('array');
      expect(params[0].required).toBe(false);
      expect(params[0].paramSchema).toEqual({
        type: 'array',
        items: {type: 'object', properties: {name: {type: 'string'}}},
      });
    });

    it('should leave a scalar request body unnamed', () => {
      const params = new OperationParser(
        operationWithBody({type: 'string'}),
      ).getParameters();

      expect(params.length).toBe(1);
      expect(params[0].originalName).toBe('');
      expect(params[0].name).toBe('body');
      expect(params[0].required).toBe(false);
    });

    it('should name a oneOf request body body', () => {
      const parser = new OperationParser(
        operationWithBody({oneOf: [{type: 'string'}, {type: 'integer'}]}),
      );
      const params = parser.getParameters();

      expect(params.length).toBe(1);
      expect(params[0].originalName).toBe('body');
      expect(params[0].name).toBe('body');
      expect(Object.keys(parser.getJsonSchema().properties ?? {})).toEqual([
        'body',
      ]);
    });

    it('should add no parameter for an object body with no properties', () => {
      const params = new OperationParser(
        operationWithBody({type: 'object'}),
      ).getParameters();

      expect(params.length).toBe(0);
    });

    it('should number duplicate names from zero', () => {
      const params = new OperationParser({
        operationId: 'testOp',
        parameters: [
          {name: 'test', in: 'query', schema: {type: 'string'}},
          {name: 'test', in: 'header', schema: {type: 'string'}},
          {name: 'test', in: 'path', schema: {type: 'string'}},
        ],
        responses: {},
      }).getParameters();

      expect(params.map((param) => param.name)).toEqual([
        'test',
        'test_0',
        'test_1',
      ]);
    });

    it('should parse a plain object that matches an operation', () => {
      const parser = new OperationParser({
        operationId: 'get_thing',
        responses: {},
      });

      expect(parser.getFunctionName()).toBe('get_thing');
    });
  });

  describe('return value', () => {
    function returnSchemaOf(
      responses: OpenAPIV3.ResponsesObject,
    ): OpenAPIV3.SchemaObject {
      return new OperationParser({
        operationId: 'testOp',
        responses,
      }).getReturnValue().paramSchema;
    }

    it('should take the schema of the 200 response', () => {
      expect(
        returnSchemaOf({
          '200': {
            description: 'Success',
            content: {'application/json': {schema: {type: 'string'}}},
          },
        }),
      ).toEqual({type: 'string'});
    });

    it('should stay empty when no response is a 2xx', () => {
      expect(
        returnSchemaOf({
          '400': {
            description: 'Bad request',
            content: {'application/json': {schema: {type: 'string'}}},
          },
        }),
      ).toEqual({});
    });

    it('should take the smallest 2xx response', () => {
      expect(
        returnSchemaOf({
          '202': {
            description: 'Accepted',
            content: {'application/json': {schema: {type: 'string'}}},
          },
          '200': {
            description: 'Success',
            content: {'application/json': {schema: {type: 'boolean'}}},
          },
          '201': {
            description: 'Created',
            content: {'application/json': {schema: {type: 'integer'}}},
          },
        }),
      ).toEqual({type: 'boolean'});
    });

    it('should stay empty when the response carries no content', () => {
      expect(
        returnSchemaOf({'200': {description: 'Success', content: {}}}),
      ).toEqual({});
    });

    it('should stay empty when the media type carries no schema', () => {
      expect(
        returnSchemaOf({
          '200': {description: 'Success', content: {'application/json': {}}},
        }),
      ).toEqual({});
    });

    it('should stay empty when the response is a reference', () => {
      expect(
        returnSchemaOf({'200': {$ref: '#/components/responses/Ok'}}),
      ).toEqual({});
    });

    it('should stay empty when the media type schema is a reference', () => {
      expect(
        returnSchemaOf({
          '200': {
            description: 'Success',
            content: {
              'application/json': {schema: {$ref: '#/components/schemas/Pet'}},
            },
          },
        }),
      ).toEqual({});
    });

    it('should name the return value and mark it required', () => {
      const returnValue = new OperationParser(
        sampleOperation(),
      ).getReturnValue();

      expect(returnValue.paramSchema).toEqual({type: 'string'});
      expect(returnValue.name).toBe('return');
      expect(returnValue.required).toBe(true);
    });
  });

  describe('function name', () => {
    it('should snake_case the operationId', () => {
      expect(new OperationParser(sampleOperation()).getFunctionName()).toBe(
        'test_operation',
      );
    });

    it('should snake_case the operationId even when preserving names', () => {
      const parser = new OperationParser(
        {operationId: 'getUserPosts', responses: {}},
        {preservePropertyNames: true},
      );

      expect(parser.getFunctionName()).toBe('get_user_posts');
    });

    it('should cut a long name to 60 characters', () => {
      const parser = new OperationParser({
        operationId: 'a'.repeat(70),
        responses: {},
      });

      expect(parser.getFunctionName()).toBe('a'.repeat(60));
    });
  });

  describe('auth scheme name', () => {
    function schemeNameOf(
      security?: OpenAPIV3.SecurityRequirementObject[],
    ): string {
      return new OperationParser({
        operationId: 'testOp',
        responses: {},
        security,
      }).getAuthSchemeName();
    }

    it('should name the scheme the operation requires', () => {
      expect(new OperationParser(sampleOperation()).getAuthSchemeName()).toBe(
        'oauth2',
      );
    });

    it('should name no scheme when the operation declares none', () => {
      expect(schemeNameOf()).toBe('');
      expect(schemeNameOf([])).toBe('');
    });

    it('should name no scheme when a requirement is empty', () => {
      expect(schemeNameOf([{}])).toBe('');
    });

    it('should name no scheme when the empty requirement comes first', () => {
      expect(schemeNameOf([{}, {apiKey: []}])).toBe('');
    });

    it('should name no scheme when the empty requirement comes last', () => {
      expect(schemeNameOf([{apiKey: []}, {}])).toBe('');
    });
  });

  describe('description', () => {
    it('should prefer the description over the summary', () => {
      expect(new OperationParser(sampleOperation()).getDescription()).toBe(
        'Test Description',
      );
    });

    it('should fall back to the summary when there is no description', () => {
      expect(
        new OperationParser({
          operationId: 'testOp',
          summary: 'The summary',
          responses: {},
        }).getDescription(),
      ).toBe('The summary');
    });
  });

  describe('json schema', () => {
    it('should describe the arguments of the operation', () => {
      const schema = new OperationParser(sampleOperation()).getJsonSchema();

      expect(schema.title).toBe('test_operation_Arguments');
      expect(schema.type).toBe('object');
      expect(schema.properties).toHaveProperty('param1');
      expect(schema.properties).toHaveProperty('prop1');
    });

    it('should emit an empty required array when nothing is required', () => {
      expect(new OperationParser(sampleOperation()).getJsonSchema()).toEqual(
        expect.objectContaining({required: []}),
      );
    });

    it('should title the schema unnamed when the operation has no id', () => {
      const schema = new OperationParser({responses: {}}).getJsonSchema();

      expect(schema.title).toBe('unnamed_Arguments');
    });

    it('should copy the schemas so a caller cannot reach the spec', () => {
      const operation = sampleOperation();
      const parser = new OperationParser(operation);

      const properties = parser.getJsonSchema().properties as Record<
        string,
        OpenAPIV3.SchemaObject
      >;
      properties['param1'].type = 'boolean';

      const parameter = operation.parameters?.[0];
      expect(parameter && 'schema' in parameter && parameter.schema).toEqual({
        type: 'string',
      });
    });
  });

  describe('preserved property names', () => {
    it('should keep the original property name', () => {
      const params = new OperationParser(
        operationWithBody({
          type: 'object',
          properties: {spaceName: {type: 'string'}},
        }),
        {preservePropertyNames: true},
      ).getParameters();

      expect(params[0].name).toBe('spaceName');
    });

    it('should still prefix a reserved word', () => {
      const params = new OperationParser(
        operationWithBody({
          type: 'object',
          properties: {class: {type: 'string'}},
        }),
        {preservePropertyNames: true},
      ).getParameters();

      expect(params[0].name).toBe('param_class');
    });
  });

  describe('request body edge cases', () => {
    it('should add no parameter for a referenced request body', () => {
      const params = new OperationParser({
        operationId: 'testOp',
        requestBody: {$ref: '#/components/requestBodies/Pet'},
        responses: {},
      }).getParameters();

      expect(params.length).toBe(0);
    });

    it('should add no parameter for a request body with no content', () => {
      const params = new OperationParser({
        operationId: 'testOp',
        requestBody: {content: {}},
        responses: {},
      }).getParameters();

      expect(params.length).toBe(0);
    });

    it('should add no parameter for a media type with no schema', () => {
      const params = new OperationParser({
        operationId: 'testOp',
        requestBody: {content: {'application/json': {}}},
        responses: {},
      }).getParameters();

      expect(params.length).toBe(0);
    });

    it('should add no parameter for a referenced body schema', () => {
      const params = new OperationParser({
        operationId: 'testOp',
        requestBody: {
          content: {
            'application/json': {schema: {$ref: '#/components/schemas/Pet'}},
          },
        },
        responses: {},
      }).getParameters();

      expect(params.length).toBe(0);
    });

    it('should skip a referenced body property', () => {
      const params = new OperationParser(
        operationWithBody({
          type: 'object',
          properties: {
            kept: {type: 'string'},
            skipped: {$ref: '#/components/schemas/Pet'},
          },
        }),
      ).getParameters();

      expect(params.map((param) => param.originalName)).toEqual(['kept']);
    });

    it('should name a typeless request body body', () => {
      const params = new OperationParser(
        operationWithBody({description: 'Anything'}),
      ).getParameters();

      expect(params[0].originalName).toBe('body');
      expect(params[0].description).toBe('Anything');
    });

    it('should not require a body even when the spec marks it required', () => {
      const parser = new OperationParser({
        operationId: 'testOp',
        requestBody: {
          required: true,
          content: {'application/json': {schema: {type: 'string'}}},
        },
        responses: {},
      });

      expect(parser.getParameters()[0].name).toBe('body');
      expect(parser.getParameters()[0].required).toBe(false);
      expect(parser.getJsonSchema().required).toEqual([]);
    });

    it('should describe a body from the request body description', () => {
      const params = new OperationParser({
        operationId: 'testOp',
        requestBody: {
          description: 'The payload',
          content: {'application/json': {schema: {type: 'string'}}},
        },
        responses: {},
      }).getParameters();

      expect(params[0].description).toBe('The payload');
    });
  });

  describe('operation parameter edge cases', () => {
    it('should skip a referenced parameter', () => {
      const params = new OperationParser({
        operationId: 'testOp',
        parameters: [{$ref: '#/components/parameters/TraceId'}],
        responses: {},
      }).getParameters();

      expect(params.length).toBe(0);
    });

    it('should default a parameter with no schema and no location', () => {
      const params = new OperationParser({
        operationId: 'testOp',
        parameters: [{name: '', in: ''} as OpenAPIV3.ParameterObject],
        responses: {},
      }).getParameters();

      expect(params[0].name).toBe('value');
      expect(params[0].paramSchema).toEqual({});
      expect(params[0].required).toBe(false);
      expect(params[0].description).toBe('');
    });
  });

  describe('JSON string operation', () => {
    const operation: OpenAPIV3.OperationObject = {
      operationId: 'getUser',
      parameters: [
        {
          name: 'X-Api-Key',
          in: 'header',
          required: true,
          schema: {type: 'string'},
        },
      ],
      responses: {
        '200': {
          description: 'ok',
          content: {'application/json': {schema: {type: 'string'}}},
        },
      },
    };

    it('should parse a JSON string the same as the equivalent object', () => {
      const fromJson = new OperationParser(JSON.stringify(operation));
      const fromObject = new OperationParser(operation);

      expect(fromJson.getParameters()).toEqual(fromObject.getParameters());
      expect(fromJson.getReturnValue()).toEqual(fromObject.getReturnValue());
      expect(fromJson.getFunctionName()).toBe(fromObject.getFunctionName());
      expect(fromJson.getParameters()[0].name).toBe('x_api_key');
    });

    it('should honour the options when the operation is a JSON string', () => {
      const parser = new OperationParser(JSON.stringify(operation), {
        preservePropertyNames: true,
      });

      expect(parser.getParameters()[0].name).toBe('X-Api-Key');
    });

    it('should throw when the string is not JSON', () => {
      expect(() => new OperationParser('{not json')).toThrow(
        /Operation is not valid JSON/,
      );
    });

    it.each([
      ['an array', '[]'],
      ['null', 'null'],
      ['a string', '"x"'],
      ['a number', '7'],
    ])('should throw when the JSON is %s', (_label, json) => {
      expect(() => new OperationParser(json)).toThrow(
        'Operation must be a JSON object',
      );
    });
  });
});
