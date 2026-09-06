/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {toGeminiSchema} from '../../src/utils/gemini_schema_util.js';

// A type alias, not an interface: only an alias gets the implicit index
// signature that makes it assignable to the converter's JSON Schema input.
type MCPToolSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
};

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

  it('keeps a supported integer format on a property', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {id: {type: 'integer', format: 'int64'}},
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {id: {type: Type.INTEGER, format: 'int64'}},
    });
  });

  it('keeps a supported string format on a property', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {when: {type: 'string', format: 'date-time'}},
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {when: {type: Type.STRING, format: 'date-time'}},
    });
  });

  it('drops an unsupported string format on a property', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {who: {type: 'string', format: 'email'}},
    });

    expect(schema?.properties?.['who'].format).toBeUndefined();
  });

  it('keeps a supported format inside array items', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {
        ids: {type: 'array', items: {type: 'integer', format: 'int32'}},
        names: {type: 'array', items: {type: 'string', format: 'uri'}},
      },
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        ids: {
          type: Type.ARRAY,
          items: {type: Type.INTEGER, format: 'int32'},
        },
        names: {type: Type.ARRAY, items: {type: Type.STRING}},
      },
    });
  });

  it('keeps a supported format inside an anyOf branch', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {
        value: {
          anyOf: [
            {type: 'string', format: 'email'},
            {type: 'string', format: 'date-time'},
          ],
        },
      },
    });

    expect(schema?.properties?.['value'].anyOf).toEqual([
      {type: Type.STRING},
      {type: Type.STRING, format: 'date-time'},
    ]);
  });

  it('does not mutate the schema it was given', () => {
    const input = {
      type: 'object' as const,
      properties: {who: {type: 'string', format: 'email'}},
    };
    const pristine = structuredClone(input);

    toGeminiSchema(input);

    expect(input).toEqual(pristine);
  });

  it('carries pattern, minimum, maximum and default through', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {
        slug: {type: 'string', pattern: '^[a-z]+$', default: 'abc'},
        score: {type: 'integer', minimum: 1, maximum: 10, default: 5},
      },
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        slug: {type: Type.STRING, pattern: '^[a-z]+$', default: 'abc'},
        score: {type: Type.INTEGER, minimum: 1, maximum: 10, default: 5},
      },
    });
  });

  it('stringifies every count and length bound', () => {
    const schema = toGeminiSchema({
      type: 'object',
      minProperties: 1,
      maxProperties: 4,
      properties: {
        name: {type: 'string', minLength: 3, maxLength: 40},
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 9,
          items: {type: 'string'},
        },
      },
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      minProperties: '1',
      maxProperties: '4',
      properties: {
        name: {type: Type.STRING, minLength: '3', maxLength: '40'},
        tags: {
          type: Type.ARRAY,
          minItems: '1',
          maxItems: '9',
          items: {type: Type.STRING},
        },
      },
    });
  });

  it('carries a false default rather than treating it as absent', () => {
    const schema = toGeminiSchema({type: 'boolean', default: false});

    expect(schema).toEqual({type: Type.BOOLEAN, default: false});
  });

  it('drops a bound, a pattern and a propertyOrdering of the wrong type', () => {
    const schema = toGeminiSchema({
      type: 'object',
      minProperties: '2',
      pattern: 7,
      minimum: 'low',
      maximum: 'high',
      propertyOrdering: ['a', 3],
      properties: {},
    });

    expect(schema).toEqual({type: Type.OBJECT, properties: {}});
  });

  it('drops a format that is not a string', () => {
    expect(toGeminiSchema({type: 'integer', format: 64})).toEqual({
      type: Type.INTEGER,
    });
  });

  it('drops the synthetic title an OpenAPI operation carries', () => {
    const schema = toGeminiSchema({
      type: 'object',
      title: 'upload_file_Arguments',
      properties: {},
    });

    expect(schema).toEqual({type: Type.OBJECT, properties: {}});
  });

  it('keeps a property named format and drops that property own format', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {format: {type: 'string', format: 'email'}},
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {format: {type: Type.STRING}},
    });
  });

  it('keeps a property named properties', () => {
    const schema = toGeminiSchema({
      type: 'object',
      properties: {properties: {type: 'string', format: 'date-time'}},
    });

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {properties: {type: Type.STRING, format: 'date-time'}},
    });
  });
});
