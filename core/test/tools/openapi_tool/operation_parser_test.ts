/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OperationParser} from '@google/adk';
import {Type} from '@google/genai';
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

  describe('getReturnValue', () => {
    it('should return the schema of the 2xx response', () => {
      const op: OpenAPIV3.OperationObject = {
        operationId: 'testOp',
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {type: 'object', properties: {id: {type: 'integer'}}},
              },
            },
          },
        },
      };

      const returnValue = new OperationParser(op).getReturnValue();

      expect(returnValue).toEqual({
        originalName: '',
        paramLocation: '',
        paramSchema: {type: 'object', properties: {id: {type: 'integer'}}},
        required: true,
        name: 'return',
      });
    });

    it('should return the schema of the lowest 2xx response', () => {
      const op: OpenAPIV3.OperationObject = {
        operationId: 'testOp',
        responses: {
          '202': {
            description: 'Accepted',
            content: {'application/json': {schema: {type: 'boolean'}}},
          },
          '200': {
            description: 'OK',
            content: {'application/json': {schema: {type: 'string'}}},
          },
        },
      };

      expect(new OperationParser(op).getReturnValue().paramSchema.type).toBe(
        'string',
      );
    });

    const emptySchemaCases: Array<[string, OpenAPIV3.ResponsesObject]> = [
      ['the operation declares no responses', {}],
      ['no response is 2xx', {'404': {description: 'Not found'}}],
      ['the 2xx response is a reference', {'200': {$ref: '#/x'}}],
      ['the 2xx response has no content', {'200': {description: 'OK'}}],
      [
        'the 2xx response declares no media type',
        {'200': {description: 'OK', content: {}}},
      ],
      [
        'the 2xx schema is an unresolved reference',
        {
          '200': {
            description: 'OK',
            content: {'application/json': {schema: {$ref: '#/x'}}},
          },
        },
      ],
    ];

    it.each(emptySchemaCases)(
      'should return an empty schema when %s',
      (_, responses) => {
        const returnValue = new OperationParser({
          operationId: 'testOp',
          responses,
        }).getReturnValue();

        expect(returnValue.paramSchema).toEqual({});
        expect(returnValue.name).toBe('return');
      },
    );
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

    it('should keep the caller-supplied parameters and return value', () => {
      const parameters = [
        {
          originalName: 'renamed',
          paramLocation: 'query',
          paramSchema: {type: 'string'} as OpenAPIV3.SchemaObject,
          name: 'renamed',
          required: true,
        },
      ];
      const returnValue = {
        originalName: '',
        paramLocation: '',
        paramSchema: {type: 'boolean'} as OpenAPIV3.SchemaObject,
        name: 'return',
        required: true,
      };

      const parser = new OperationParser(sampleOperation(), {
        parameters,
        returnValue,
      });

      expect(parser.getParameters()).toEqual(parameters);
      expect(parser.getReturnValue()).toBe(returnValue);
    });

    it('should keep an empty return value when the caller supplies none', () => {
      const parser = new OperationParser(sampleOperation(), {parameters: []});

      expect(parser.getReturnValue().paramSchema).toEqual({});
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
    function parserWithResponses(
      responses: OpenAPIV3.ResponsesObject,
    ): OperationParser {
      return new OperationParser({operationId: 'testOp', responses});
    }

    it('should take the schema of the 200 response', () => {
      expect(
        parserWithResponses({
          '200': {
            description: 'Success',
            content: {'application/json': {schema: {type: 'string'}}},
          },
        }).getReturnTypeHint(),
      ).toBe('string');
    });

    it('should return unknown when no response is a 2xx', () => {
      expect(
        parserWithResponses({
          '400': {
            description: 'Bad request',
            content: {'application/json': {schema: {type: 'string'}}},
          },
        }).getReturnTypeHint(),
      ).toBe('unknown');
    });

    it('should take the smallest 2xx response', () => {
      expect(
        parserWithResponses({
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
        }).getReturnTypeHint(),
      ).toBe('boolean');
    });

    it('should return unknown when the response carries no content', () => {
      expect(
        parserWithResponses({
          '200': {description: 'Success', content: {}},
        }).getReturnTypeHint(),
      ).toBe('unknown');
    });

    it('should return unknown when the media type carries no schema', () => {
      expect(
        parserWithResponses({
          '200': {description: 'Success', content: {'application/json': {}}},
        }).getReturnTypeHint(),
      ).toBe('unknown');
    });

    it('should return unknown when the response is a reference', () => {
      expect(
        parserWithResponses({
          '200': {$ref: '#/components/responses/Ok'},
        }).getReturnTypeHint(),
      ).toBe('unknown');
    });

    it('should return unknown when the media type schema is a reference', () => {
      expect(
        parserWithResponses({
          '200': {
            description: 'Success',
            content: {
              'application/json': {schema: {$ref: '#/components/schemas/Pet'}},
            },
          },
        }).getReturnTypeHint(),
      ).toBe('unknown');
    });

    it('should carry the response schema on the return value', () => {
      const returnValue = new OperationParser(
        sampleOperation(),
      ).getReturnValue();

      expect(returnValue.paramSchema).toEqual({type: 'string'});
      expect(returnValue.name).toBe('return');
    });

    it('should map the return schema onto a Gemini type', () => {
      expect(new OperationParser(sampleOperation()).getReturnTypeValue()).toBe(
        Type.STRING,
      );
    });

    it('should map an absent return type onto TYPE_UNSPECIFIED', () => {
      expect(parserWithResponses({}).getReturnTypeValue()).toBe(
        Type.TYPE_UNSPECIFIED,
      );
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

  describe('documentation', () => {
    it('should document the summary, the arguments and the return', () => {
      const doc = new OperationParser(sampleOperation()).getDocString();

      expect(doc).toContain('Test Summary');
      expect(doc).toContain('Args:');
      expect(doc).toContain('param1 (string): Parameter 1');
      expect(doc).toContain('prop1 (string): Property 1');
      expect(doc).toContain('Returns (string): Success');
    });

    it('should prefer the summary over the description', () => {
      const doc = new OperationParser({
        operationId: 'testOp',
        summary: 'The summary',
        description: 'The description',
        responses: {},
      }).getDocString();

      expect(doc.startsWith('The summary\n')).toBe(true);
    });

    it('should fall back to the description when there is no summary', () => {
      const doc = new OperationParser({
        operationId: 'testOp',
        description: 'The description',
        responses: {},
      }).getDocString();

      expect(doc.startsWith('The description\n')).toBe(true);
    });

    it('should document an operation that declares no responses', () => {
      const doc = new OperationParser(
        '{"operationId": "testOp", "summary": "The summary"}',
      ).getDocString();

      expect(doc).toBe('The summary\n\nArgs:\n\n\n');
    });

    it('should document an operation with neither summary nor description', () => {
      const doc = new OperationParser({
        operationId: 'testOp',
        responses: {},
      }).getDocString();

      expect(doc).toBe('\n\nArgs:\n\n\n');
    });

    it('should document a response that carries no description', () => {
      const doc = new OperationParser(
        '{"operationId": "testOp", "summary": "S", "responses": {"200": {"content": {"application/json": {"schema": {"type": "string"}}}}}}',
      ).getDocString();

      expect(doc).toContain('Returns (string): ');
    });

    it('should prefer the description over the summary in getDescription', () => {
      expect(new OperationParser(sampleOperation()).getDescription()).toBe(
        'Test Description',
      );
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

  describe('operation supplied as JSON', () => {
    it('should parse a JSON operation', () => {
      const parser = new OperationParser(
        '{"operationId": "get_thing", "responses": {}}',
      );

      expect(parser.getFunctionName()).toBe('get_thing');
    });

    it('should reject JSON holding an array', () => {
      expect(() => new OperationParser('[]')).toThrow(
        'Operation must be a JSON object',
      );
    });

    it('should reject JSON holding a string', () => {
      expect(() => new OperationParser('"x"')).toThrow(
        'Operation must be a JSON object',
      );
    });

    it('should reject JSON holding null', () => {
      expect(() => new OperationParser('null')).toThrow(
        'Operation must be a JSON object',
      );
    });

    it('should let malformed JSON raise a SyntaxError', () => {
      expect(() => new OperationParser('{')).toThrow(SyntaxError);
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

    it('should add no parameter for a request body that omits content', () => {
      const params = new OperationParser(
        '{"operationId": "testOp", "requestBody": {}, "responses": {}}',
      ).getParameters();

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
});
