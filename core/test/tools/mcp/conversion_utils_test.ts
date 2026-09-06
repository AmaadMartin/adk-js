/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool, adkToMcpToolType, geminiToJsonSchema} from '@google/adk';
import {FunctionDeclaration, Type} from '@google/genai';
import {ToolSchema} from '@modelcontextprotocol/sdk/types.js';
import {describe, expect, it} from 'vitest';

/** A tool that returns whatever declaration a test gives it. */
class DeclaredTool extends BaseTool {
  private readonly declaration: FunctionDeclaration | undefined;

  constructor(
    name: string,
    description: string,
    declaration?: FunctionDeclaration,
  ) {
    super({name, description});
    this.declaration = declaration;
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declaration;
  }

  override async runAsync(): Promise<unknown> {
    return undefined;
  }
}

describe('adkToMcpToolType', () => {
  it('emits an empty object schema when the tool has no declaration', () => {
    const tool = new DeclaredTool('test_tool', 'Test tool');

    // adk-python emits `{}` here. The MCP TypeScript SDK types `inputSchema.type`
    // as the literal 'object', so the port emits the empty object schema.
    expect(adkToMcpToolType(tool)).toEqual({
      name: 'test_tool',
      description: 'Test tool',
      inputSchema: {type: 'object'},
    });
  });

  it('converts a parameters schema', () => {
    const tool = new DeclaredTool('get_weather', 'Gets weather information', {
      name: 'get_weather',
      description: 'Gets weather information',
      parameters: {
        type: Type.OBJECT,
        properties: {
          location: {
            type: Type.STRING,
            description: 'The location to get weather for',
          },
          units: {type: Type.STRING, description: 'Temperature units'},
        },
        required: ['location'],
      },
    });

    expect(adkToMcpToolType(tool)).toEqual({
      name: 'get_weather',
      description: 'Gets weather information',
      inputSchema: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'The location to get weather for',
          },
          units: {type: 'string', description: 'Temperature units'},
        },
        required: ['location'],
      },
    });
  });

  it('emits a parametersJsonSchema document verbatim', () => {
    const parametersJsonSchema = {
      type: 'object',
      properties: {
        query: {type: 'string', description: 'The search query'},
        limit: {type: 'integer', description: 'Maximum number of results'},
      },
      required: ['query'],
    };
    const tool = new DeclaredTool('search_database', 'Searches a database', {
      name: 'search_database',
      description: 'Searches a database',
      parametersJsonSchema,
    });

    expect(adkToMcpToolType(tool).inputSchema).toEqual(parametersJsonSchema);
  });

  it('emits an empty object schema when the declaration has no parameters', () => {
    const tool = new DeclaredTool('get_current_time', 'Gets the current time', {
      name: 'get_current_time',
      description: 'Gets the current time',
    });

    expect(adkToMcpToolType(tool).inputSchema).toEqual({type: 'object'});
  });

  it('prefers parametersJsonSchema over parameters', () => {
    const parametersJsonSchema = {
      type: 'object',
      properties: {jsonParam: {type: 'string'}},
    };
    const tool = new DeclaredTool('test_tool', 'Test tool', {
      name: 'test_tool',
      description: 'Test tool',
      parameters: {
        type: Type.OBJECT,
        properties: {schemaParam: {type: Type.STRING}},
      },
      parametersJsonSchema,
    });

    expect(adkToMcpToolType(tool).inputSchema).toEqual(parametersJsonSchema);
  });

  it('keeps a deeply nested parametersJsonSchema intact', () => {
    const parametersJsonSchema = {
      type: 'object',
      properties: {
        username: {type: 'string'},
        profile: {
          type: 'object',
          properties: {
            email: {type: 'string'},
            age: {type: 'integer'},
            tags: {type: 'array', items: {type: 'string'}},
          },
          required: ['email'],
        },
      },
      required: ['username', 'profile'],
    };
    const tool = new DeclaredTool('create_user', 'Creates a new user', {
      name: 'create_user',
      description: 'Creates a new user',
      parametersJsonSchema,
    });

    expect(adkToMcpToolType(tool).inputSchema).toEqual(parametersJsonSchema);
  });

  it('fills in a missing type on a parametersJsonSchema document', () => {
    const tool = new DeclaredTool('list_items', 'Lists items', {
      name: 'list_items',
      description: 'Lists items',
      parametersJsonSchema: {properties: {page: {type: 'integer'}}},
    });

    expect(adkToMcpToolType(tool).inputSchema).toEqual({
      type: 'object',
      properties: {page: {type: 'integer'}},
    });
  });

  it('returns a descriptor that satisfies the MCP ToolSchema', () => {
    const tool = new DeclaredTool('get_weather', 'Gets weather information', {
      name: 'get_weather',
      description: 'Gets weather information',
      parameters: {
        type: Type.OBJECT,
        properties: {location: {type: Type.STRING}},
        required: ['location'],
      },
    });

    expect(() => ToolSchema.parse(adkToMcpToolType(tool))).not.toThrow();
  });

  it('returns a ToolSchema-valid descriptor for a tool with no declaration', () => {
    const tool = new DeclaredTool('ping', 'Pings the server');

    expect(() => ToolSchema.parse(adkToMcpToolType(tool))).not.toThrow();
  });

  it('rejects a parameters schema that is not an object schema', () => {
    const tool = new DeclaredTool('echo', 'Echoes a string', {
      name: 'echo',
      description: 'Echoes a string',
      parameters: {type: Type.STRING},
    });

    expect(() => adkToMcpToolType(tool)).toThrow(TypeError);
    expect(() => adkToMcpToolType(tool)).toThrow(
      'Tool "echo" declares parameters of type "string"; ' +
        'an MCP tool must declare an object schema.',
    );
  });

  it('rejects an untyped parameters schema', () => {
    const tool = new DeclaredTool('untyped', 'Has an untyped schema', {
      name: 'untyped',
      description: 'Has an untyped schema',
      parameters: {description: 'no type here'},
    });

    expect(() => adkToMcpToolType(tool)).toThrow(
      'Tool "untyped" declares parameters of type "null"; ' +
        'an MCP tool must declare an object schema.',
    );
  });

  it('rejects a parametersJsonSchema that is not a JSON object', () => {
    const tool = new DeclaredTool('broken', 'Has a broken schema', {
      name: 'broken',
      description: 'Has a broken schema',
      parametersJsonSchema: 42,
    });

    expect(() => adkToMcpToolType(tool)).toThrow(TypeError);
    expect(() => adkToMcpToolType(tool)).toThrow(
      'Tool "broken" declares parameters of type 42; ' +
        'an MCP tool must declare an object schema.',
    );
  });
});

describe('geminiToJsonSchema', () => {
  // The compiler does not check a schema parsed from JSON, so the runtime
  // guard is what rejects these.
  it.each(['null', '"STRING"', '[]'])(
    'rejects the JSON document %s, which is not a schema object',
    (json) => {
      expect(() => geminiToJsonSchema(JSON.parse(json))).toThrow(TypeError);
      expect(() => geminiToJsonSchema(JSON.parse(json))).toThrow(
        `Input must be a Schema object, got ${json}.`,
      );
    },
  );

  it('maps an absent type to null', () => {
    expect(geminiToJsonSchema({})).toEqual({type: 'null'});
  });

  it('maps TYPE_UNSPECIFIED to null', () => {
    expect(geminiToJsonSchema({type: Type.TYPE_UNSPECIFIED})).toEqual({
      type: 'null',
    });
  });

  it('lower-cases the type', () => {
    expect(geminiToJsonSchema({type: Type.STRING})).toEqual({type: 'string'});
  });

  it('copies the direct fields under the same name', () => {
    expect(
      geminiToJsonSchema({
        type: Type.STRING,
        title: 'City',
        description: 'A city name',
        default: 'Paris',
        enum: ['Paris', 'Rome'],
        format: 'enum',
        example: 'Rome',
      }),
    ).toEqual({
      type: 'string',
      title: 'City',
      description: 'A city name',
      default: 'Paris',
      enum: ['Paris', 'Rome'],
      format: 'enum',
      example: 'Rome',
    });
  });

  it('emits nullable true without widening the type', () => {
    expect(geminiToJsonSchema({type: Type.STRING, nullable: true})).toEqual({
      type: 'string',
      nullable: true,
    });
  });

  it('omits nullable false', () => {
    expect(geminiToJsonSchema({type: Type.STRING, nullable: false})).toEqual({
      type: 'string',
    });
  });

  it('converts the string constraints to numbers', () => {
    expect(
      geminiToJsonSchema({
        type: Type.STRING,
        pattern: '^a.*',
        minLength: '2',
        maxLength: '8',
      }),
    ).toEqual({
      type: 'string',
      pattern: '^a.*',
      minLength: 2,
      maxLength: 8,
    });
  });

  it('drops the string constraints on a non-string type', () => {
    expect(
      geminiToJsonSchema({
        type: Type.INTEGER,
        minLength: '2',
        maxLength: '8',
        minimum: 1,
      }),
    ).toEqual({type: 'integer', minimum: 1});
  });

  it('drops the numeric constraints on a string type', () => {
    expect(
      geminiToJsonSchema({
        type: Type.STRING,
        minimum: 1,
        maximum: 5,
        pattern: 'x',
      }),
    ).toEqual({type: 'string', pattern: 'x'});
  });

  it('keeps the numeric constraints on a number type', () => {
    expect(
      geminiToJsonSchema({type: Type.NUMBER, minimum: 0.5, maximum: 9.5}),
    ).toEqual({type: 'number', minimum: 0.5, maximum: 9.5});
  });

  it('converts array items recursively', () => {
    expect(
      geminiToJsonSchema({
        type: Type.ARRAY,
        items: {type: Type.STRING, maxLength: '4'},
        minItems: '1',
        maxItems: '3',
      }),
    ).toEqual({
      type: 'array',
      items: {type: 'string', maxLength: 4},
      minItems: 1,
      maxItems: 3,
    });
  });

  it('omits the items key for an array without items', () => {
    expect(geminiToJsonSchema({type: Type.ARRAY})).toEqual({type: 'array'});
  });

  it('converts object properties recursively', () => {
    expect(
      geminiToJsonSchema({
        type: Type.OBJECT,
        properties: {
          name: {type: Type.STRING, maxLength: '10'},
          tags: {type: Type.ARRAY, items: {type: Type.STRING}},
        },
        required: ['name'],
        minProperties: '1',
        maxProperties: '2',
      }),
    ).toEqual({
      type: 'object',
      properties: {
        name: {type: 'string', maxLength: 10},
        tags: {type: 'array', items: {type: 'string'}},
      },
      required: ['name'],
      minProperties: 1,
      maxProperties: 2,
    });
  });

  it('omits the properties key for an object without properties', () => {
    expect(geminiToJsonSchema({type: Type.OBJECT})).toEqual({type: 'object'});
  });

  it('never emits propertyOrdering', () => {
    expect(
      geminiToJsonSchema({
        type: Type.OBJECT,
        properties: {b: {type: Type.STRING}},
        propertyOrdering: ['b'],
      }),
    ).toEqual({type: 'object', properties: {b: {type: 'string'}}});
  });

  it('converts anyOf subschemas recursively', () => {
    expect(
      geminiToJsonSchema({
        anyOf: [{type: Type.STRING}, {type: Type.INTEGER, minimum: 0}],
      }),
    ).toEqual({
      type: 'null',
      anyOf: [{type: 'string'}, {type: 'integer', minimum: 0}],
    });
  });

  it('leaves the input schema untouched', () => {
    const schema = {type: Type.STRING, minLength: '2'};

    geminiToJsonSchema(schema);

    expect(schema).toEqual({type: Type.STRING, minLength: '2'});
  });

  it('maps a boolean type', () => {
    expect(geminiToJsonSchema({type: Type.BOOLEAN})).toEqual({
      type: 'boolean',
    });
  });
});
