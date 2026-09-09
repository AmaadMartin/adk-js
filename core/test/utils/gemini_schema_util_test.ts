/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {toGeminiSchema} from '../../src/utils/gemini_schema_util.js';

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

  it('forwards object and string bounds as strings', () => {
    const input = {
      type: 'object',
      minProperties: 1,
      maxProperties: 10,
      properties: {
        firstName: {type: 'string', minLength: 1, maxLength: 50},
      },
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      minProperties: '1',
      maxProperties: '10',
      properties: {
        firstName: {type: Type.STRING, minLength: '1', maxLength: '50'},
      },
    });
  });

  it('forwards array bounds as strings', () => {
    const input = {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {type: 'string'},
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.ARRAY,
      minItems: '1',
      maxItems: '5',
      items: {type: Type.STRING},
    });
  });

  it('forwards a numeric range as numbers, including zero', () => {
    const input = {type: 'integer', minimum: 0, maximum: 100};

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.INTEGER,
      minimum: 0,
      maximum: 100,
    });
  });

  it('forwards falsy constraint values', () => {
    const input = {
      type: 'string',
      default: '',
      title: '',
      pattern: '',
      minLength: 0,
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      default: '',
      title: '',
      pattern: '',
      minLength: '0',
    });
  });

  it('forwards a false default on a boolean node', () => {
    const input = {type: 'boolean', default: false};

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({type: Type.BOOLEAN, default: false});
  });

  it('drops a constraint whose value is null', () => {
    const input = {
      type: 'string',
      minLength: null,
      pattern: null,
      minimum: null,
      default: null,
      propertyOrdering: null,
      format: null,
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({type: Type.STRING});
  });

  it('forwards pattern, default and title verbatim', () => {
    const input = {
      type: 'string',
      pattern: '^[a-z]+$',
      default: 'abc',
      title: 'Name',
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      pattern: '^[a-z]+$',
      default: 'abc',
      title: 'Name',
    });
  });

  it('forwards propertyOrdering', () => {
    const input = {
      type: 'object',
      propertyOrdering: ['name', 'age'],
      properties: {
        name: {type: 'string'},
        age: {type: 'integer'},
      },
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      propertyOrdering: ['name', 'age'],
      properties: {
        name: {type: Type.STRING},
        age: {type: Type.INTEGER},
      },
    });
  });

  it('keeps int32 and int64 on an integer node and drops any other format', () => {
    const input = {
      type: 'object',
      properties: {
        small: {type: 'integer', format: 'int32'},
        big: {type: 'integer', format: 'int64'},
        unsupported: {type: 'integer', format: 'unsigned'},
      },
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        small: {type: Type.INTEGER, format: 'int32'},
        big: {type: Type.INTEGER, format: 'int64'},
        unsupported: {type: Type.INTEGER},
      },
    });
  });

  it('keeps date-time and enum on a string node and drops any other format', () => {
    const input = {
      type: 'object',
      properties: {
        when: {type: 'string', format: 'date-time'},
        choice: {type: 'string', format: 'enum'},
        day: {type: 'string', format: 'date'},
        address: {type: 'string', format: 'email'},
        blob: {type: 'string', format: 'byte'},
      },
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        when: {type: Type.STRING, format: 'date-time'},
        choice: {type: Type.STRING, format: 'enum'},
        day: {type: Type.STRING},
        address: {type: Type.STRING},
        blob: {type: Type.STRING},
      },
    });
  });

  it('keeps int32 on a number node and drops float and double', () => {
    const input = {
      type: 'object',
      properties: {
        count: {type: 'number', format: 'int32'},
        ratio: {type: 'number', format: 'float'},
        precise: {type: 'number', format: 'double'},
      },
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        count: {type: Type.NUMBER, format: 'int32'},
        ratio: {type: Type.NUMBER},
        precise: {type: Type.NUMBER},
      },
    });
  });

  it('drops a format on a node that declares no type', () => {
    const input = {
      format: 'date-time',
      properties: {
        field1: {format: 'int32'},
      },
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        field1: {type: Type.TYPE_UNSPECIFIED},
      },
    });
  });

  it('drops a format that only an inferred type would license', () => {
    const input = {enum: ['2026-01-01'], format: 'date-time'};

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      enum: ['2026-01-01'],
    });
  });

  it('filters constraints at every nesting depth', () => {
    const input = {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: {
            when: {type: 'string', format: 'date-time', minLength: 3},
            link: {type: 'string', format: 'uri'},
          },
        },
        tags: {
          type: 'array',
          items: {type: 'string', format: 'uri', minLength: 2},
        },
      },
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        nested: {
          type: Type.OBJECT,
          properties: {
            when: {type: Type.STRING, format: 'date-time', minLength: '3'},
            link: {type: Type.STRING},
          },
        },
        tags: {
          type: Type.ARRAY,
          items: {type: Type.STRING, minLength: '2'},
        },
      },
    });
  });

  it('filters a format per anyOf branch', () => {
    const input = {
      anyOf: [
        {type: 'string', format: 'email'},
        {type: 'integer', format: 'int32'},
        {type: 'string', format: 'date-time'},
      ],
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      anyOf: [
        {type: Type.STRING},
        {type: Type.INTEGER, format: 'int32'},
        {type: Type.STRING, format: 'date-time'},
      ],
    });
  });

  it('keeps constraints when a nullable union collapses to one type', () => {
    const input = {
      type: ['string', 'null'],
      minLength: 2,
      format: 'date-time',
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.STRING,
      description: undefined,
      nullable: true,
      minLength: '2',
      format: 'date-time',
    });
  });

  it('drops keywords the Gemini schema does not model', () => {
    const input = {
      type: 'object',
      additionalProperties: false,
      uniqueItems: true,
      exclusiveMinimum: 1,
      somethingElse: 'x',
      properties: {
        a: {type: 'string', multipleOf: 2},
      },
    };

    const schema = toGeminiSchema(input as unknown as MCPToolSchema);

    expect(schema).toEqual({
      type: Type.OBJECT,
      properties: {
        a: {type: Type.STRING},
      },
    });
  });
});
