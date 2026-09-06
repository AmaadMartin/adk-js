/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {toGeminiSchema} from '../../src/utils/gemini_schema_util.js';

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

  function domainPayloadDefinitions() {
    return {
      DeviceEnum: {
        enum: ['GLOBAL', 'desktop', 'mobile'],
        title: 'DeviceEnum',
        type: 'string',
      },
      DomainPayload: {
        properties: {
          adDomain: {
            description: 'List of one or many domains.',
            items: {type: 'string'},
            title: 'Addomain',
            type: 'array',
          },
          device: {
            $ref: '#/$defs/DeviceEnum',
            default: 'GLOBAL',
            description: 'Filter by device.',
          },
        },
        required: ['adDomain'],
        title: 'DomainPayload',
        type: 'object',
      },
    };
  }

  const expectedDomainPayload = {
    type: Type.OBJECT,
    properties: {
      adDomain: {
        type: Type.ARRAY,
        description: 'List of one or many domains.',
        items: {type: Type.STRING},
      },
      device: {
        type: Type.STRING,
        description: 'Filter by device.',
        enum: ['GLOBAL', 'desktop', 'mobile'],
      },
    },
    required: ['adDomain'],
  };

  function domainPayloadSchema() {
    return {
      $defs: domainPayloadDefinitions(),
      properties: {payload: {$ref: '#/$defs/DomainPayload'}},
      required: ['payload'],
      title: 'query_domainsArguments',
      type: 'object',
    };
  }

  it('resolves a $defs $ref to the referenced definition', () => {
    const schema = toGeminiSchema(domainPayloadSchema());

    expect(schema?.properties?.['payload']).toEqual(expectedDomainPayload);
  });

  it('resolves a draft-07 definitions $ref', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      definitions: {
        DeviceEnum: {
          enum: ['GLOBAL', 'desktop', 'mobile'],
          title: 'DeviceEnum',
          type: 'string',
        },
        DomainPayload: {
          properties: {
            adDomain: {
              description: 'List of one or many domains.',
              items: {type: 'string'},
              title: 'Addomain',
              type: 'array',
            },
            device: {
              $ref: '#/definitions/DeviceEnum',
              default: 'GLOBAL',
              description: 'Filter by device.',
            },
          },
          required: ['adDomain'],
          title: 'DomainPayload',
          type: 'object',
        },
      },
      properties: {payload: {$ref: '#/definitions/DomainPayload'}},
      required: ['payload'],
      type: 'object',
    };

    const schema = toGeminiSchema(input);

    expect(schema?.properties?.['payload']).toEqual(expectedDomainPayload);
  });

  it('resolves a $ref used as array items', () => {
    const input = {
      $defs: {Item: {type: 'string'}},
      type: 'array',
      items: {$ref: '#/$defs/Item'},
    };

    const schema = toGeminiSchema(input);

    expect(schema).toEqual({type: Type.ARRAY, items: {type: Type.STRING}});
  });

  it('lets sibling keys override the resolved definition', () => {
    const input = {
      $defs: {Thing: {type: 'string', description: 'from def'}},
      type: 'object',
      properties: {a: {$ref: '#/$defs/Thing', description: 'from sibling'}},
    };

    const schema = toGeminiSchema(input);

    expect(schema?.properties?.['a']).toEqual({
      type: Type.STRING,
      description: 'from sibling',
    });
  });

  it('leaves an unresolvable $ref alone when a $defs block exists', () => {
    const input = {
      $defs: {Known: {type: 'string'}},
      type: 'object',
      properties: {a: {$ref: '#/$defs/Missing'}},
    };

    expect(() => toGeminiSchema(input)).not.toThrow();

    const schema = toGeminiSchema(input);

    expect(schema?.properties?.['a']).toEqual({
      type: Type.OBJECT,
      properties: {},
    });
  });

  it('degrades a self-referencing $ref to a placeholder object', () => {
    const input = {
      $defs: {
        Node: {
          type: 'object',
          properties: {
            name: {type: 'string'},
            parent: {$ref: '#/$defs/Node'},
          },
        },
      },
      properties: {tree: {$ref: '#/$defs/Node'}},
      type: 'object',
    };

    const schema = toGeminiSchema(input);

    expect(schema?.properties?.['tree']).toEqual({
      type: Type.OBJECT,
      properties: {
        name: {type: Type.STRING},
        parent: {
          type: Type.OBJECT,
          description: 'Circular ref to Node',
          properties: {},
        },
      },
    });
  });

  it('degrades a multi-step cycle to a placeholder object', () => {
    const input = {
      $defs: {
        Value: {
          anyOf: [{type: 'string'}, {$ref: '#/$defs/Struct'}],
        },
        Struct: {
          type: 'object',
          properties: {
            fields: {
              type: 'object',
              properties: {
                my_val: {
                  type: 'array',
                  items: {$ref: '#/$defs/Value'},
                },
              },
            },
          },
        },
      },
      properties: {root: {$ref: '#/$defs/Value'}},
      type: 'object',
    };

    const schema = toGeminiSchema(input);

    expect(schema?.properties?.['root']).toEqual({
      anyOf: [
        {type: Type.STRING},
        {
          type: Type.OBJECT,
          properties: {
            fields: {
              type: Type.OBJECT,
              properties: {
                my_val: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    description: 'Circular ref to Value',
                    properties: {},
                  },
                },
              },
            },
          },
        },
      ],
    });
  });

  it('resolves a shared definition in both sibling positions', () => {
    const input = {
      $defs: {
        CommonType: {type: 'string'},
        ObjectA: {
          type: 'object',
          properties: {prop_a: {$ref: '#/$defs/CommonType'}},
        },
        ObjectB: {
          type: 'object',
          properties: {prop_b: {$ref: '#/$defs/CommonType'}},
        },
      },
      properties: {
        a: {$ref: '#/$defs/ObjectA'},
        b: {$ref: '#/$defs/ObjectB'},
      },
      type: 'object',
    };

    const schema = toGeminiSchema(input);

    expect(schema?.properties?.['a']).toEqual({
      type: Type.OBJECT,
      properties: {prop_a: {type: Type.STRING}},
    });
    expect(schema?.properties?.['b']).toEqual({
      type: Type.OBJECT,
      properties: {prop_b: {type: Type.STRING}},
    });
  });

  it('resolves each dialect block through its own pointer', () => {
    const input = {
      $defs: {Shared: {type: 'integer'}},
      definitions: {Shared: {type: 'string'}},
      type: 'object',
      properties: {
        a: {$ref: '#/$defs/Shared'},
        b: {$ref: '#/definitions/Shared'},
      },
    };

    const schema = toGeminiSchema(input);

    expect(schema?.properties?.['a']).toEqual({type: Type.INTEGER});
    expect(schema?.properties?.['b']).toEqual({type: Type.STRING});
  });

  it('leaves an external $ref untouched', () => {
    const input = {
      type: 'object',
      properties: {a: {$ref: 'https://example.com/schema.json#/Thing'}},
    };

    const schema = toGeminiSchema(input);

    expect(schema?.properties?.['a']).toEqual({
      type: Type.OBJECT,
      properties: {},
    });
  });

  it('leaves a $ref that points at a non-schema value untouched', () => {
    const input = {
      type: 'object',
      title: 'not a schema',
      properties: {a: {$ref: '#/title'}},
    };

    const schema = toGeminiSchema(input);

    expect(schema?.properties?.['a']).toEqual({
      type: Type.OBJECT,
      properties: {},
    });
  });

  it('drops the definition blocks from the returned schema', () => {
    const schema = toGeminiSchema(domainPayloadSchema());

    if (!schema) {
      expect.fail('toGeminiSchema returned undefined');
    }
    expect('$defs' in schema).toBe(false);
    expect('definitions' in schema).toBe(false);
  });

  it('does not mutate the input schema', () => {
    const input = domainPayloadSchema();
    const snapshot = structuredClone(input);

    toGeminiSchema(input);

    expect(input).toEqual(snapshot);
  });

  it('traverses a property named $ref instead of resolving it', () => {
    const input = {
      $defs: {Thing: {type: 'string'}},
      type: 'object',
      properties: {
        $ref: {type: 'object', properties: {inner: {$ref: '#/$defs/Thing'}}},
      },
    };

    expect(() => toGeminiSchema(input)).not.toThrow();

    const schema = toGeminiSchema(input);

    expect(schema?.properties?.['$ref']).toEqual({
      type: Type.OBJECT,
      properties: {inner: {type: Type.STRING}},
    });
  });
});
