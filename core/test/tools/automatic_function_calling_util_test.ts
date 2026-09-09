/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

import {
  buildFunctionDeclaration,
  buildFunctionDeclarationFromProperties,
  buildFunctionDeclarationFromSchema,
  buildFunctionDeclarationUtil,
  JsonSchemaNode,
} from '../../src/tools/_automatic_function_calling_util.js';
import {GoogleLLMVariant} from '../../src/utils/variant_utils.js';

/** The property fixture a wrapper hands over, still carrying pydantic keywords. */
function pydanticProperties(): Record<string, JsonSchemaNode> {
  return {
    name: {title: 'Name', type: 'string'},
    nickname: {
      anyOf: [{type: 'string'}, {type: 'null'}],
      default: null,
      title: 'Nickname',
    },
    count: {default: 3, title: 'Count', type: 'integer'},
  };
}

function propertiesOf(parameters: Schema | undefined): Record<string, Schema> {
  expect(parameters).toBeDefined();
  expect(parameters?.type).toBe(Type.OBJECT);
  return parameters?.properties ?? {};
}

describe('buildFunctionDeclarationUtil', () => {
  it('maps schema type names to gemini types', () => {
    const declaration = buildFunctionDeclarationUtil({
      vertexai: false,
      name: 'lookup',
      description: 'Look a city up.',
      schema: {
        properties: {
          city: {type: 'str'},
          scores: {type: 'tuple', items: {type: 'float'}},
          meta: {type: 'Dict'},
          anything: {type: 'Any'},
        },
      },
    });

    expect(declaration.name).toBe('lookup');
    expect(declaration.description).toBe('Look a city up.');
    const properties = propertiesOf(declaration.parameters);
    expect(properties['city'].type).toBe(Type.STRING);
    expect(properties['scores'].type).toBe(Type.ARRAY);
    expect(properties['scores'].items?.type).toBe(Type.NUMBER);
    expect(properties['meta'].type).toBe(Type.OBJECT);
    expect(properties['anything'].type).toBe(Type.TYPE_UNSPECIFIED);
  });

  it('maps an unrecognised type name to TYPE_UNSPECIFIED', () => {
    const declaration = buildFunctionDeclarationUtil({
      vertexai: false,
      name: 'lookup',
      schema: {properties: {value: {type: 'complex128'}}},
    });

    expect(propertiesOf(declaration.parameters)['value'].type).toBe(
      Type.TYPE_UNSPECIFIED,
    );
  });

  it('omits parameters when the schema has no properties', () => {
    const empty = buildFunctionDeclarationUtil({
      vertexai: false,
      name: 'ping',
      description: 'Ping the service.',
      schema: {properties: {}},
    });
    const absent = buildFunctionDeclarationUtil({
      vertexai: false,
      name: 'ping',
    });

    expect(empty.parameters).toBeUndefined();
    expect(empty.description).toBe('Ping the service.');
    expect(absent.parameters).toBeUndefined();
    expect('description' in absent).toBe(false);
  });

  it('sets the response schema from the return type for vertexai', () => {
    const declaration = buildFunctionDeclarationUtil({
      vertexai: true,
      name: 'stringify',
      returnType: 'str',
      schema: {properties: {count: {type: 'integer'}}},
    });

    expect(declaration.response?.type).toBe(Type.STRING);
  });

  it('falls back to TYPE_UNSPECIFIED when no return type is given', () => {
    const declaration = buildFunctionDeclarationUtil({
      vertexai: true,
      name: 'stringify',
      schema: {properties: {count: {type: 'integer'}}},
    });

    expect(declaration.response?.type).toBe(Type.TYPE_UNSPECIFIED);
  });

  it('omits the response schema when not vertexai', () => {
    const declaration = buildFunctionDeclarationUtil({
      vertexai: false,
      name: 'stringify',
      returnType: 'str',
      schema: {properties: {count: {type: 'integer'}}},
    });

    expect(declaration.response).toBeUndefined();
  });

  it('reads the required list off the schema it is given', () => {
    const declaration = buildFunctionDeclarationUtil({
      vertexai: false,
      name: 'greet',
      schema: {properties: {name: {type: 'string'}}, required: ['name']},
    });

    expect(declaration.parameters?.required).toEqual(['name']);
  });

  it('emits an empty required list when the schema declares none', () => {
    const declaration = buildFunctionDeclarationUtil({
      vertexai: false,
      name: 'greet',
      schema: {properties: {name: {type: 'string'}}},
    });

    expect(declaration.parameters?.required).toEqual([]);
  });

  it('converts a nested object property', () => {
    const declaration = buildFunctionDeclarationUtil({
      vertexai: false,
      name: 'save',
      schema: {
        properties: {
          record: {type: 'Dict', properties: {label: {type: 'str'}}},
        },
      },
    });

    const record = propertiesOf(declaration.parameters)['record'];
    expect(record.type).toBe(Type.OBJECT);
    expect(record.properties?.['label'].type).toBe(Type.STRING);
  });

  it('skips an array property that carries no items', () => {
    const declaration = buildFunctionDeclarationUtil({
      vertexai: false,
      name: 'collect',
      schema: {properties: {values: {type: 'list'}}},
    });

    const values = propertiesOf(declaration.parameters)['values'];
    expect(values.type).toBe(Type.ARRAY);
    expect(values.items).toBeUndefined();
  });

  it('throws when the name is empty', () => {
    expect(() =>
      buildFunctionDeclarationUtil({vertexai: false, name: ''}),
    ).toThrowError('Function declaration name cannot be empty.');
  });
});

describe('buildFunctionDeclarationFromProperties', () => {
  it('normalises properties for the Gemini API', () => {
    const declaration = buildFunctionDeclarationFromProperties({
      vertexai: false,
      name: 'greet',
      description: 'Greet someone.',
      parameterProperties: pydanticProperties(),
    });

    const properties = propertiesOf(declaration.parameters);
    expect(Object.keys(properties).sort()).toEqual([
      'count',
      'name',
      'nickname',
    ]);
    expect(properties['name'].type).toBe(Type.STRING);
    expect(properties['count'].type).toBe(Type.INTEGER);
    expect(properties['nickname'].type).toBe(Type.STRING);
    expect(declaration.parameters?.required).toEqual(['name']);
    for (const property of Object.values(properties)) {
      expect(property.anyOf).toBeUndefined();
      expect(property.title).toBeUndefined();
      expect(property.default).toBeUndefined();
      expect(property.nullable).toBeUndefined();
    }
  });

  it('keeps anyOf, default, nullable and title on the Vertex path', () => {
    const declaration = buildFunctionDeclarationFromProperties({
      vertexai: true,
      name: 'greet',
      parameterProperties: pydanticProperties(),
    });

    const properties = propertiesOf(declaration.parameters);
    expect(properties['name'].title).toBe('Name');
    expect(properties['count'].default).toBe(3);
    expect(properties['nickname'].nullable).toBe(true);
    expect(properties['nickname'].anyOf).toEqual([{type: Type.STRING}]);
  });

  it('takes the last non-null union member on the Gemini path', () => {
    const declaration = buildFunctionDeclarationFromProperties({
      vertexai: false,
      name: 'coerce',
      parameterProperties: {
        value: {anyOf: [{type: 'str'}, {type: 'int'}, {type: 'null'}]},
      },
    });

    const value = propertiesOf(declaration.parameters)['value'];
    expect(value.type).toBe(Type.INTEGER);
    expect(value.anyOf).toBeUndefined();
    expect(value.nullable).toBeUndefined();
    expect(declaration.parameters?.required).toEqual([]);
  });

  it('ignores a second null union member', () => {
    const parameterProperties: Record<string, JsonSchemaNode> = {
      value: {anyOf: [{type: 'str'}, {type: 'null'}, {type: 'null'}]},
    };

    const declaration = buildFunctionDeclarationFromProperties({
      vertexai: false,
      name: 'coerce',
      parameterProperties,
    });
    const vertex = buildFunctionDeclarationFromProperties({
      vertexai: true,
      name: 'coerce',
      parameterProperties,
    });

    const value = propertiesOf(declaration.parameters)['value'];
    expect(value.type).toBe(Type.STRING);
    expect(value.anyOf).toBeUndefined();
    // Only the first null member is consumed by the nullable annotation.
    expect(propertiesOf(vertex.parameters)['value'].anyOf).toHaveLength(2);
  });

  it('maps anyOf member types and hoists the type onto the parent', () => {
    const declaration = buildFunctionDeclarationFromProperties({
      vertexai: true,
      name: 'coerce',
      parameterProperties: {value: {anyOf: [{type: 'int'}]}},
    });

    const value = propertiesOf(declaration.parameters)['value'];
    expect(value.anyOf).toEqual([{type: Type.INTEGER}]);
    expect(value.type).toBe(Type.INTEGER);
  });

  it('leaves the parent typeless when a union member declares no type', () => {
    const declaration = buildFunctionDeclarationFromProperties({
      vertexai: true,
      name: 'coerce',
      parameterProperties: {value: {anyOf: [{description: 'anything'}]}},
    });

    const value = propertiesOf(declaration.parameters)['value'];
    expect(value.type).toBeUndefined();
    expect(value.anyOf).toEqual([{description: 'anything'}]);
  });

  it('treats a property with a null or falsy default as optional', () => {
    const declaration = buildFunctionDeclarationFromProperties({
      vertexai: false,
      name: 'greet',
      parameterProperties: {
        nickname: {type: 'string', default: null},
        count: {type: 'integer', default: 0},
        label: {type: 'string', default: ''},
      },
    });

    expect(declaration.parameters?.required).toEqual([]);
  });

  it('omits parameters when no properties are given', () => {
    const declaration = buildFunctionDeclarationFromProperties({
      vertexai: false,
      name: 'ping',
    });

    expect(declaration.parameters).toBeUndefined();
  });
});

describe('buildFunctionDeclarationFromSchema', () => {
  it('reads properties out of a full model schema', () => {
    const declaration = buildFunctionDeclarationFromSchema({
      vertexai: false,
      name: 'greet',
      description: 'Greet someone.',
      schema: {
        title: 'GreetArgs',
        type: 'object',
        properties: pydanticProperties(),
        required: ['name'],
      },
    });

    const properties = propertiesOf(declaration.parameters);
    expect(Object.keys(properties).sort()).toEqual([
      'count',
      'name',
      'nickname',
    ]);
    expect(properties['name'].type).toBe(Type.STRING);
    expect(properties['nickname'].type).toBe(Type.STRING);
    expect(properties['count'].type).toBe(Type.INTEGER);
    expect(declaration.parameters?.title).toBeUndefined();
  });

  it('marks parameters without a default as required', () => {
    const declaration = buildFunctionDeclarationFromSchema({
      vertexai: false,
      name: 'greet',
      schema: {
        properties: {
          name: {title: 'Name', type: 'string'},
          count: {default: 3, title: 'Count', type: 'integer'},
        },
        required: ['name', 'count'],
      },
    });

    expect(declaration.parameters?.required).toEqual(['name']);
  });

  it('keeps a parameter the schema does not require optional', () => {
    const declaration = buildFunctionDeclarationFromSchema({
      vertexai: false,
      name: 'greet',
      schema: {
        properties: {name: {type: 'string'}, alias: {type: 'string'}},
        required: ['name'],
      },
    });

    expect(declaration.parameters?.required).toEqual(['name']);
  });

  it('omits parameters when the schema declares none', () => {
    const empty = buildFunctionDeclarationFromSchema({
      vertexai: false,
      name: 'ping',
      schema: {type: 'object'},
    });
    const absent = buildFunctionDeclarationFromSchema({
      vertexai: false,
      name: 'ping',
    });

    expect(empty.parameters).toBeUndefined();
    expect(absent.parameters).toBeUndefined();
  });
});

describe('buildFunctionDeclaration', () => {
  const parameters: JsonSchemaNode = {
    properties: {
      inputStr: {type: 'string'},
      toolContext: {type: 'object'},
    },
    required: ['inputStr', 'toolContext'],
  };

  it('drops ignored parameters', () => {
    const declaration = buildFunctionDeclaration({
      name: 'simpleFunction',
      parameters,
      ignoreParams: ['toolContext'],
    });

    const properties = propertiesOf(declaration.parameters);
    expect(properties['inputStr'].type).toBe(Type.STRING);
    expect('toolContext' in properties).toBe(false);
  });

  it('removes an ignored parameter from an inherited required list', () => {
    const declaration = buildFunctionDeclaration({
      name: 'simpleFunction',
      parameters,
      ignoreParams: ['toolContext'],
    });

    expect(declaration.parameters?.required).toEqual(['inputStr']);
  });

  it('omits parameters when every parameter is ignored', () => {
    const declaration = buildFunctionDeclaration({
      name: 'onlyContext',
      parameters,
      ignoreParams: ['inputStr', 'toolContext'],
    });

    expect(declaration.parameters).toBeUndefined();
  });

  it('omits parameters when none are given', () => {
    const declaration = buildFunctionDeclaration({name: 'ping'});

    expect(declaration.parameters).toBeUndefined();
  });

  it('includes required parameters', () => {
    const declaration = buildFunctionDeclaration({
      name: 'simpleFunction',
      parameters: {properties: {inputStr: {type: 'string'}}},
    });

    expect(declaration.parameters?.required).toEqual(['inputStr']);
  });

  it('defaults the variant to GEMINI_API', () => {
    const declaration = buildFunctionDeclaration({
      name: 'greet',
      parameters: {properties: pydanticProperties()},
      returnType: 'str',
    });

    expect(declaration.response).toBeUndefined();
    expect(
      propertiesOf(declaration.parameters)['nickname'].title,
    ).toBeUndefined();
  });

  it('omits the response schema for GEMINI_API', () => {
    const declaration = buildFunctionDeclaration({
      name: 'functionNoneReturn',
      parameters,
      returnType: 'None',
      variant: GoogleLLMVariant.GEMINI_API,
    });

    expect(declaration.response).toBeUndefined();
  });

  it('emits a typeless response schema for VERTEX_AI with no return type', () => {
    const declaration = buildFunctionDeclaration({
      name: 'functionNoReturn',
      parameters,
      variant: GoogleLLMVariant.VERTEX_AI,
    });

    expect(declaration.response).toBeDefined();
    expect(declaration.response?.type).toBeUndefined();
  });

  it('maps an explicit None return to Type.NULL for VERTEX_AI', () => {
    const declaration = buildFunctionDeclaration({
      name: 'functionNoneReturn',
      parameters,
      returnType: 'None',
      variant: GoogleLLMVariant.VERTEX_AI,
    });

    expect(declaration.response?.type).toBe(Type.NULL);
  });

  it('maps an upper-case null return type to Type.NULL for VERTEX_AI', () => {
    const declaration = buildFunctionDeclaration({
      name: 'functionNoneReturn',
      parameters,
      returnType: Type.NULL,
      variant: GoogleLLMVariant.VERTEX_AI,
    });

    expect(declaration.response?.type).toBe(Type.NULL);
  });

  it('maps a regular return type for VERTEX_AI', () => {
    const declaration = buildFunctionDeclaration({
      name: 'functionStringReturn',
      parameters,
      returnType: 'str',
      variant: GoogleLLMVariant.VERTEX_AI,
    });

    expect(declaration.response?.type).toBe(Type.STRING);
  });

  it('accepts a Zod object as the parameter source', () => {
    const declaration = buildFunctionDeclaration({
      name: 'greet',
      parameters: z.object({
        name: z.string(),
        count: z.number().optional(),
      }),
    });

    const properties = propertiesOf(declaration.parameters);
    expect(properties['name'].type).toBe(Type.STRING);
    expect(properties['count'].type).toBe(Type.NUMBER);
    expect(declaration.parameters?.required).toEqual(['name']);
  });

  it('collapses a Zod union with null to the non-null member', () => {
    const declaration = buildFunctionDeclaration({
      name: 'greet',
      parameters: z.object({nickname: z.union([z.string(), z.null()])}),
    });

    // zodObjectToSchema spells the null member `NULL`, which still has to be
    // recognised as the null member.
    const nickname = propertiesOf(declaration.parameters)['nickname'];
    expect(nickname.type).toBe(Type.STRING);
    expect(nickname.anyOf).toBeUndefined();
    expect(declaration.parameters?.required).toEqual([]);
  });

  it('accepts a genai Schema as the parameter source', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        name: {type: Type.STRING},
        count: {type: Type.INTEGER, default: 3},
      },
    };

    const declaration = buildFunctionDeclaration({
      name: 'greet',
      parameters: schema,
    });

    const properties = propertiesOf(declaration.parameters);
    expect(properties['name'].type).toBe(Type.STRING);
    expect(properties['count'].type).toBe(Type.INTEGER);
    expect(declaration.parameters?.required).toEqual(['name']);
  });

  it('recognises a genai Type.NULL union member on the Vertex path', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        nickname: {anyOf: [{type: Type.STRING}, {type: Type.NULL}]},
      },
    };

    const declaration = buildFunctionDeclaration({
      name: 'greet',
      parameters: schema,
      variant: GoogleLLMVariant.VERTEX_AI,
    });

    const nickname = propertiesOf(declaration.parameters)['nickname'];
    expect(nickname.nullable).toBe(true);
    expect(nickname.anyOf).toEqual([{type: Type.STRING}]);
    expect(nickname.type).toBe(Type.STRING);
  });

  it('throws when the name is empty', () => {
    expect(() => buildFunctionDeclaration({name: ''})).toThrowError(
      'Function declaration name cannot be empty.',
    );
  });
});

describe('input handling', () => {
  it('does not mutate the caller schema', () => {
    const schema: JsonSchemaNode = {
      title: 'GreetArgs',
      type: 'object',
      properties: pydanticProperties(),
      required: ['name', 'count'],
    };
    const clone = structuredClone(schema);

    buildFunctionDeclarationUtil({vertexai: false, name: 'greet', schema});
    buildFunctionDeclarationFromSchema({
      vertexai: false,
      name: 'greet',
      schema,
    });
    buildFunctionDeclarationFromProperties({
      vertexai: false,
      name: 'greet',
      parameterProperties: schema.properties,
    });
    buildFunctionDeclaration({
      name: 'greet',
      parameters: schema,
      ignoreParams: ['count'],
      variant: GoogleLLMVariant.VERTEX_AI,
    });

    expect(schema).toEqual(clone);
  });
});
