/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
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
});

describe('sanitizeSchemaFormatsForGemini', () => {
  it('test_sanitize_integer_formats', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: 'object',
      properties: {
        int32_field: {type: 'integer', format: 'int32'},
        int64_field: {type: 'integer', format: 'int64'},
        invalid_int_format: {type: 'integer', format: 'unsigned'},
      },
    });

    expect(sanitized).toEqual({
      type: 'object',
      properties: {
        int32_field: {type: 'integer', format: 'int32'},
        int64_field: {type: 'integer', format: 'int64'},
        invalid_int_format: {type: 'integer'},
      },
    });
  });

  it('test_sanitize_string_formats', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: 'object',
      properties: {
        datetime_field: {type: 'string', format: 'date-time'},
        enum_field: {type: 'string', format: 'enum', enum: ['a', 'b']},
        date_field: {type: 'string', format: 'date'},
        email_field: {type: 'string', format: 'email'},
        byte_field: {type: 'string', format: 'byte'},
      },
    });

    expect(sanitized).toEqual({
      type: 'object',
      properties: {
        datetime_field: {type: 'string', format: 'date-time'},
        enum_field: {type: 'string', format: 'enum', enum: ['a', 'b']},
        date_field: {type: 'string'},
        email_field: {type: 'string'},
        byte_field: {type: 'string'},
      },
    });
  });

  it('test_sanitize_number_formats', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: 'object',
      properties: {
        float_field: {type: 'number', format: 'float'},
        double_field: {type: 'number', format: 'double'},
        int32_number: {type: 'number', format: 'int32'},
      },
    });

    expect(sanitized).toEqual({
      type: 'object',
      properties: {
        float_field: {type: 'number'},
        double_field: {type: 'number'},
        int32_number: {type: 'number', format: 'int32'},
      },
    });
  });

  it('test_sanitize_nested_formats', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            date_str: {type: 'string', format: 'date'},
            int_field: {type: 'integer', format: 'int64'},
          },
        },
        array_field: {
          type: 'array',
          items: {type: 'string', format: 'uri'},
        },
      },
    });

    expect(sanitized).toEqual({
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            date_str: {type: 'string'},
            int_field: {type: 'integer', format: 'int64'},
          },
        },
        array_field: {type: 'array', items: {type: 'string'}},
      },
    });
  });

  it('test_sanitize_anyof_formats', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      anyOf: [
        {type: 'string', format: 'email'},
        {type: 'integer', format: 'int32'},
        {type: 'string', format: 'date-time'},
      ],
    });

    expect(sanitized).toEqual({
      anyOf: [
        {type: 'string'},
        {type: 'integer', format: 'int32'},
        {type: 'string', format: 'date-time'},
      ],
    });
  });

  it('test_preserve_valid_formats_without_type', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      format: 'date-time',
      properties: {field1: {format: 'int32'}},
    });

    expect(sanitized).toEqual({properties: {field1: {}}});
  });

  it('test_to_gemini_schema_remove_unrecognized_fields', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: 'string',
      description: 'A single date string.',
      format: 'date',
    });

    expect(sanitized).toEqual({
      type: 'string',
      description: 'A single date string.',
    });
  });

  it('keeps a property named format and drops that property own format', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: 'object',
      properties: {format: {type: 'string', format: 'email'}},
    });

    expect(sanitized).toEqual({
      type: 'object',
      properties: {format: {type: 'string'}},
    });
  });

  it('keeps a property named properties', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: 'object',
      properties: {properties: {type: 'string', format: 'date-time'}},
    });

    expect(sanitized).toEqual({
      type: 'object',
      properties: {properties: {type: 'string', format: 'date-time'}},
    });
  });

  it('passes string arrays such as required and enum through untouched', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: 'object',
      required: ['a', 'b'],
      properties: {a: {type: 'string', enum: ['x', 'y']}},
    });

    expect(sanitized).toEqual({
      type: 'object',
      required: ['a', 'b'],
      properties: {a: {type: 'string', enum: ['x', 'y']}},
    });
  });

  it('does not mutate the node it was given', () => {
    const input = {
      type: 'object',
      properties: {
        a: {type: 'string', format: 'email'},
        b: {type: 'array', items: {type: 'integer', format: 'unsigned'}},
      },
    };
    const pristine = structuredClone(input);

    sanitizeSchemaFormatsForGemini(input);

    expect(input).toEqual(pristine);
  });

  it('is idempotent', () => {
    const input = {
      type: 'object',
      properties: {
        a: {type: 'string', format: 'email'},
        b: {type: 'integer', format: 'int64'},
      },
    };

    const once = sanitizeSchemaFormatsForGemini(input);

    expect(sanitizeSchemaFormatsForGemini(once)).toEqual(once);
  });

  it('drops the format when type is an array', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: ['string', 'null'],
      format: 'date-time',
    });

    expect(sanitized).toEqual({type: ['string', 'null']});
  });

  it('returns a primitive value unchanged', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: 'string',
      title: 'A title',
      minLength: 1,
      nullable: true,
      default: null,
      required: undefined,
    });

    expect(sanitized).toEqual({
      type: 'string',
      title: 'A title',
      minLength: 1,
      nullable: true,
      default: null,
      required: undefined,
    });
  });

  it('drops a format that is not a string', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: 'integer',
      format: 64,
    });

    expect(sanitized).toEqual({type: 'integer'});
  });

  it('recurses into a properties value that is not an object', () => {
    const sanitized = sanitizeSchemaFormatsForGemini({
      type: 'object',
      properties: [{type: 'string', format: 'email'}],
    });

    expect(sanitized).toEqual({
      type: 'object',
      properties: [{type: 'string'}],
    });
  });
});
