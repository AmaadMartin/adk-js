/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  jsonSchemaToGeminiSchema,
  toGeminiSchema,
} from '../../src/utils/gemini_schema_util.js';

interface MCPToolSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
}

describe('toGeminiSchema', () => {
  it('converts a simple object schema with explicit type', () => {
    const input: MCPToolSchema = {
      type: 'object',
      properties: {
        name: {type: 'string'},
        age: {type: 'number'},
      },
      required: ['name'],
    };

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        name: {type: Type.STRING},
        age: {type: Type.NUMBER},
      },
      required: ['name'],
    });
  });

  it('infers OBJECT type from properties when type is missing', () => {
    const input = {
      properties: {
        name: {type: 'string'},
      },
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        name: {type: Type.STRING},
      },
    });
  });

  it('infers ARRAY type from items when type is missing', () => {
    const input = {
      items: {type: 'string'},
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.ARRAY,
      items: {type: Type.STRING},
    });
  });

  it('handles optional types (anyOf with null) by picking the non-null type', () => {
    const input = {
      anyOf: [{type: 'string'}, {type: 'null'}],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    // Should resolve to STRING
    expect(schema).toEqual({
      type: Type.STRING,
      nullable: true,
    });
  });

  it('handles optional types (anyOf with null) reverse order', () => {
    const input = {
      anyOf: [{type: 'null'}, {type: 'string'}],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      nullable: true,
    });
  });

  it('handles anyOf with null only', () => {
    const input = {
      anyOf: [{type: 'null'}],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.NULL,
    });
  });

  it('handles nested complex schemas with missing types', () => {
    const input = {
      // Missing top-level type, inferred as OBJECT
      properties: {
        tags: {
          // Missing array type, inferred as ARRAY
          items: {type: 'string'},
        },
        metadata: {
          // Optional object via anyOf
          anyOf: [
            {
              properties: {created: {type: 'string'}},
            },
            {type: 'null'},
          ],
        },
      },
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        tags: {
          type: Type.ARRAY,
          items: {type: Type.STRING},
        },
        metadata: {
          type: Type.OBJECT,
          properties: {
            created: {type: Type.STRING},
          },
          nullable: true,
        },
      },
    });
  });

  it('handles $ref by defaulting to OBJECT', () => {
    const input = {
      $ref: '#/definitions/MyType',
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {},
    });
  });

  it('handles array-typed type field with null – picks non-null type', () => {
    const input = {
      type: ['string', 'null'],
      description: 'an optional string',
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      description: 'an optional string',
      nullable: true,
    });
  });

  it('handles array-typed type field without null – picks the single non-null type', () => {
    const input = {
      type: ['integer'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.INTEGER,
      description: undefined,
    });
  });

  it('handles array-typed type field with case-insensitive NULL', () => {
    const input = {
      type: ['boolean', 'NULL'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.BOOLEAN,
      description: undefined,
      nullable: true,
    });
  });

  it('handles array-typed type field with reverse order', () => {
    const input = {
      type: ['null', 'boolean'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.BOOLEAN,
      description: undefined,
      nullable: true,
    });
  });

  it('handles array-typed type field with only null', () => {
    const input = {
      type: ['null'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.NULL,
      description: undefined,
    });
  });

  it('handles type null', () => {
    const input = {
      type: 'null',
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.NULL,
      description: undefined,
    });
  });

  it('handles empty items schema for arrays (e.g., items: {}) without crashing', () => {
    const input = {
      type: 'array',
      items: {}, // valid JSON Schema meaning "any", seen in AWS MCP server
    };

    expect(() =>
      toGeminiSchema(input as unknown as MCPToolSchema),
    ).not.toThrow();

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    // For empty items schema, items type becomes TYPE_UNSPECIFIED
    expect(schema).toEqual({
      type: Type.ARRAY,
      items: {type: Type.TYPE_UNSPECIFIED},
    });
  });

  it('handles TYPE_UNSPECIFIED when without type and without anyOf', () => {
    const input = {
      description: 'only description',
    };

    expect(() =>
      toGeminiSchema(input as unknown as MCPToolSchema),
    ).not.toThrow();

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.TYPE_UNSPECIFIED,
      description: 'only description',
    });
  });

  it('handles type array with multiple non-null types via anyOf', () => {
    const input = {
      type: ['string', 'integer', 'null'],
      description: 'multi-type field',
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      description: 'multi-type field',
      anyOf: [{type: Type.STRING}, {type: Type.INTEGER}, {type: Type.NULL}],
    });
  });

  it('handles type array with multiple non-null types in reverse order via anyOf', () => {
    const input = {
      type: ['null', 'integer', 'string'],
      description: 'multi-type field',
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      description: 'multi-type field',
      anyOf: [{type: Type.NULL}, {type: Type.INTEGER}, {type: Type.STRING}],
    });
  });

  it('handles type array with multiple non-null types without null', () => {
    const input = {
      type: ['string', 'integer'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      anyOf: [{type: Type.STRING}, {type: Type.INTEGER}],
    });
  });

  it('handles anyOf with multiple non-null types and null', () => {
    const input = {
      anyOf: [{type: 'string'}, {type: 'integer'}, {type: 'null'}],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      anyOf: [{type: Type.STRING}, {type: Type.INTEGER}, {type: Type.NULL}],
    });
  });

  it('handles enum-only schema (no type field) without crashing', () => {
    const input = {
      enum: ['red', 'green', 'blue'],
    };

    expect(() =>
      toGeminiSchema(input as unknown as MCPToolSchema),
    ).not.toThrow();

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      enum: ['red', 'green', 'blue'],
    });
  });

  it('handles enum-only schema with description', () => {
    const input = {
      description: 'A color value',
      enum: ['red', 'green', 'blue'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      description: 'A color value',
      enum: ['red', 'green', 'blue'],
    });
  });

  it('handles enum-only schema with mixed types (no type inferred)', () => {
    const input = {
      enum: ['red', 1, true],
    };

    expect(() =>
      toGeminiSchema(input as unknown as MCPToolSchema),
    ).not.toThrow();

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.TYPE_UNSPECIFIED,
      enum: ['red', '1', 'true'],
    });
  });

  it('handles enum with explicit type field', () => {
    const input = {
      type: 'string' as const,
      enum: ['asc', 'desc'],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      enum: ['asc', 'desc'],
    });
  });

  it('handles const-only schema with string value', () => {
    const input = {
      const: 'fixed-value',
    };

    expect(() =>
      toGeminiSchema(input as unknown as MCPToolSchema),
    ).not.toThrow();

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    // const is not a Gemini Schema field; type is inferred from the const value
    // and the value is forwarded as a single-element enum
    expect(schema).toEqual({
      type: Type.STRING,
      enum: ['fixed-value'],
    });
  });

  it('handles const-only schema with numeric value', () => {
    const input = {
      const: 42,
    };

    expect(() =>
      toGeminiSchema(input as unknown as MCPToolSchema),
    ).not.toThrow();

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.NUMBER,
      enum: ['42'],
    });
  });

  it('handles anyOf with multiple non-null object types', () => {
    const input = {
      anyOf: [
        {type: 'object', properties: {a: {type: 'string'}}},
        {type: 'string'},
      ],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      anyOf: [
        {type: Type.OBJECT, properties: {a: {type: Type.STRING}}},
        {type: Type.STRING},
      ],
    });
  });
});

describe('jsonSchemaToGeminiSchema', () => {
  it('turns an empty schema into an object', () => {
    expect(jsonSchemaToGeminiSchema({})).toEqual({type: Type.OBJECT});
  });

  it('leaves a typeless but non-empty schema without a type', () => {
    expect(jsonSchemaToGeminiSchema({title: 'only'})).toEqual({title: 'only'});
  });

  it('drops keywords the genai Schema does not declare', () => {
    const schema = jsonSchemaToGeminiSchema({
      type: 'object',
      additionalProperties: false,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      unknownTopLevelKey: 'x',
    });

    expect(schema).toEqual({type: Type.OBJECT});
  });

  it('drops a format the integer type does not support', () => {
    expect(
      jsonSchemaToGeminiSchema({type: 'integer', format: 'unsigned'}),
    ).toEqual({type: Type.INTEGER});
  });

  it('keeps int32 on an integer', () => {
    expect(
      jsonSchemaToGeminiSchema({type: 'integer', format: 'int32'}),
    ).toEqual({type: Type.INTEGER, format: 'int32'});
  });

  it('drops a format the string type does not support', () => {
    expect(jsonSchemaToGeminiSchema({type: 'string', format: 'uuid'})).toEqual({
      type: Type.STRING,
    });
  });

  it('keeps date-time on a string', () => {
    expect(
      jsonSchemaToGeminiSchema({type: 'string', format: 'date-time'}),
    ).toEqual({type: Type.STRING, format: 'date-time'});
  });

  it('turns the null type into a nullable object', () => {
    expect(jsonSchemaToGeminiSchema({type: 'null'})).toEqual({
      type: Type.OBJECT,
      nullable: true,
    });
  });

  it('turns a nullable union into a type plus a nullable flag', () => {
    expect(jsonSchemaToGeminiSchema({type: ['string', 'null']})).toEqual({
      type: Type.STRING,
      nullable: true,
    });
  });

  it('keeps only the first named member of a union', () => {
    expect(
      jsonSchemaToGeminiSchema({type: ['string', 'null', 'integer']}),
    ).toEqual({type: Type.STRING, nullable: true});
  });

  it('reads a single-member union', () => {
    expect(jsonSchemaToGeminiSchema({type: ['string']})).toEqual({
      type: Type.STRING,
    });
  });

  it('turns a null-only union into a nullable object', () => {
    expect(jsonSchemaToGeminiSchema({type: ['null']})).toEqual({
      type: Type.OBJECT,
      nullable: true,
    });
  });

  it('still types a null-only schema that carries other fields', () => {
    expect(
      jsonSchemaToGeminiSchema({type: 'null', description: 'nothing'}),
    ).toEqual({
      type: Type.OBJECT,
      description: 'nothing',
      nullable: true,
    });
  });

  it('drops a null field value', () => {
    expect(jsonSchemaToGeminiSchema({type: 'string', default: null})).toEqual({
      type: Type.STRING,
    });
  });

  it('drops an undefined field value', () => {
    expect(
      jsonSchemaToGeminiSchema({type: 'object', required: undefined}),
    ).toEqual({type: Type.OBJECT});
  });

  it('stringifies count bounds and recurses into items', () => {
    expect(
      jsonSchemaToGeminiSchema({
        type: 'array',
        items: {type: 'string'},
        minItems: 1,
        maxItems: 3,
      }),
    ).toEqual({
      type: Type.ARRAY,
      items: {type: Type.STRING},
      minItems: '1',
      maxItems: '3',
    });
  });

  it('leaves a count bound that is not a number alone', () => {
    expect(jsonSchemaToGeminiSchema({type: 'array', minItems: '2'})).toEqual({
      type: Type.ARRAY,
      minItems: '2',
    });
  });

  it('recurses into anyOf and keeps no type on the parent', () => {
    expect(
      jsonSchemaToGeminiSchema({
        anyOf: [{type: 'string'}, {type: 'null'}],
        default: null,
        title: 'T',
      }),
    ).toEqual({
      anyOf: [{type: Type.STRING}, {type: Type.OBJECT, nullable: true}],
      title: 'T',
    });
  });

  it('sanitizes a property without renaming it', () => {
    expect(
      jsonSchemaToGeminiSchema({
        type: 'object',
        properties: {camelCaseKey: {type: 'string', format: 'uuid'}},
      }),
    ).toEqual({
      type: Type.OBJECT,
      properties: {camelCaseKey: {type: Type.STRING}},
    });
  });

  it('drops unsupported keywords at nested depth', () => {
    const schema = jsonSchemaToGeminiSchema({
      type: 'object',
      properties: {
        nested: {
          type: 'string',
          description: 'kept',
          additionalProperties: false,
          'x-vendor': 'dropped',
          allOf: [{type: 'string'}],
          $defs: {other: {type: 'string'}},
        },
      },
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {nested: {type: Type.STRING, description: 'kept'}},
    });
  });

  it('never rewrites a property name', () => {
    const schema = jsonSchemaToGeminiSchema({
      type: 'object',
      properties: {snake_case_key: {type: 'string'}, camelCaseKey: {}},
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        snake_case_key: {type: Type.STRING},
        camelCaseKey: {type: Type.OBJECT},
      },
    });
    expect(schema.properties).not.toHaveProperty('snakeCaseKey');
  });

  it('sanitizes through properties, items and properties again', () => {
    expect(
      jsonSchemaToGeminiSchema({
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {id: {type: 'string', format: 'uuid'}},
              additionalProperties: false,
            },
          },
        },
      }),
    ).toEqual({
      type: Type.OBJECT,
      properties: {
        rows: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {id: {type: Type.STRING}},
          },
        },
      },
    });
  });

  it('stringifies enum members', () => {
    expect(
      jsonSchemaToGeminiSchema({type: 'integer', enum: [101, 201]}),
    ).toEqual({type: Type.INTEGER, enum: ['101', '201']});
  });

  it('does not mutate its input', () => {
    const input = {
      type: ['string', 'null'],
      format: 'uuid',
      additionalProperties: false,
      properties: {a: {type: 'string', min_length: 1}},
    };
    const clone = structuredClone(input);

    jsonSchemaToGeminiSchema(input);

    expect(input).toEqual(clone);
  });

  it('tolerates malformed nodes instead of throwing', () => {
    expect(
      jsonSchemaToGeminiSchema({
        type: 42,
        items: 'nonsense',
        anyOf: 'nonsense',
        properties: 42,
        enum: 'nonsense',
      }),
    ).toEqual({type: Type.OBJECT});
  });

  it('drops a property whose schema is not an object', () => {
    expect(
      jsonSchemaToGeminiSchema({
        type: 'object',
        properties: {good: {type: 'string'}, bad: 'nonsense'},
      }),
    ).toEqual({type: Type.OBJECT, properties: {good: {type: Type.STRING}}});
  });

  it('drops an anyOf member that is not an object', () => {
    expect(
      jsonSchemaToGeminiSchema({anyOf: [{type: 'string'}, 'nonsense']}),
    ).toEqual({anyOf: [{type: Type.STRING}]});
  });

  it('drops a format that is not a string', () => {
    expect(jsonSchemaToGeminiSchema({type: 'string', format: 42})).toEqual({
      type: Type.STRING,
    });
  });

  it('drops a format on a type that supports none', () => {
    expect(jsonSchemaToGeminiSchema({type: 'array', format: 'binary'})).toEqual(
      {type: Type.ARRAY},
    );
  });

  it('drops a format on a schema with no resolved type', () => {
    expect(jsonSchemaToGeminiSchema({title: 'T', format: 'date-time'})).toEqual(
      {title: 'T'},
    );
  });
});
