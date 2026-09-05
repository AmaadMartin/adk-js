/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  sanitizeSchemaFormatsForGemini,
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

describe('sanitizeSchemaFormatsForGemini', () => {
  it('keeps int32 and int64 on a numeric type', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: Type.OBJECT,
      properties: {
        count: {type: Type.INTEGER, format: 'int32'},
        size: {type: Type.NUMBER, format: 'int64'},
      },
    });

    expect(sanitized.properties!['count'].format).toBe('int32');
    expect(sanitized.properties!['size'].format).toBe('int64');
  });

  it('drops any other format on a numeric type', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: Type.INTEGER,
      format: 'uint8',
    });

    expect(sanitized.format).toBeUndefined();
    expect(sanitized.type).toBe(Type.INTEGER);
  });

  it('keeps date-time and enum on a string type', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: Type.OBJECT,
      properties: {
        seenAt: {type: Type.STRING, format: 'date-time'},
        kind: {type: Type.STRING, format: 'enum'},
      },
    });

    expect(sanitized.properties!['seenAt'].format).toBe('date-time');
    expect(sanitized.properties!['kind'].format).toBe('enum');
  });

  it('drops any other format on a string type', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: Type.OBJECT,
      properties: {
        contact: {type: Type.STRING, format: 'email'},
        home: {type: Type.STRING, format: 'uri'},
        born: {type: Type.STRING, format: 'date'},
      },
    });

    expect(sanitized.properties!['contact'].format).toBeUndefined();
    expect(sanitized.properties!['home'].format).toBeUndefined();
    expect(sanitized.properties!['born'].format).toBeUndefined();
  });

  it('drops a format carried by any other type', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: Type.BOOLEAN,
      format: 'int32',
    });

    expect(sanitized.format).toBeUndefined();
  });

  it('recurses through items and anyOf', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: Type.ARRAY,
      items: {
        anyOf: [
          {type: Type.STRING, format: 'email'},
          {type: Type.STRING, format: 'date-time'},
        ],
      },
    });

    expect(sanitized.items!.anyOf![0].format).toBeUndefined();
    expect(sanitized.items!.anyOf![1].format).toBe('date-time');
  });

  it('does not mutate the schema it is given', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        contact: {type: Type.STRING, format: 'email'},
        tags: {type: Type.ARRAY, items: {type: Type.STRING, format: 'uri'}},
      },
    };
    const before = JSON.stringify(schema);

    sanitizeSchemaFormatsForGemini(schema);

    expect(JSON.stringify(schema)).toBe(before);
  });
});
