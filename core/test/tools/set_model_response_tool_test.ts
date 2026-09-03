/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Context,
  createSession,
  InvocationContext,
  PluginManager,
  SchemaLike,
  SET_MODEL_RESPONSE_TOOL_NAME,
  SetModelResponseTool,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z} from 'zod/v4';

const personSchema = z.object({
  name: z.string().describe("A person's name"),
  age: z.number().describe("A person's age"),
  city: z.string().describe('The city they live in'),
});

const complexSchema = z.object({
  id: z.number(),
  title: z.string(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.string()).default({}),
  isActive: z.boolean().default(true),
});

const itemSchema = z.object({
  id: z.number().describe('Item ID'),
  name: z.string().describe('Item name'),
});

const subSchema = z.object({
  field1: z.string().describe('Field 1'),
  field2: z.number().describe('Field 2'),
});

const rawGenaiSchema: Schema = {
  type: Type.OBJECT,
  properties: {result: {type: Type.STRING}},
};

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: {} as BaseAgent,
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
    }),
  });
}

function declarationParameters(outputSchema: SchemaLike): Schema {
  const declaration = new SetModelResponseTool(outputSchema)._getDeclaration();
  const parameters = declaration?.parameters;
  if (!parameters) {
    expect.fail('the tool declared no parameters');
  }
  return parameters;
}

describe('SetModelResponseTool initialization', () => {
  it.each<[string, SchemaLike]>([
    ['a simple object schema', personSchema],
    ['a complex object schema', complexSchema],
    ['a list of objects', z.array(itemSchema)],
    ['a list of strings', z.array(z.string())],
    ['a record schema', z.record(z.string(), z.number())],
    ['a raw genai Schema', rawGenaiSchema],
  ])('names the tool set_model_response for %s', (_label, outputSchema) => {
    const tool = new SetModelResponseTool(outputSchema);

    expect(tool.name).toBe(SET_MODEL_RESPONSE_TOOL_NAME);
    expect(tool.description).toContain('final response');
  });
});

describe('SetModelResponseTool declaration', () => {
  it('turns an object schema into one parameter per field', () => {
    const parameters = declarationParameters(personSchema);

    expect(parameters.type).toBe(Type.OBJECT);
    expect(Object.keys(parameters.properties ?? {})).toEqual([
      'name',
      'age',
      'city',
    ]);
  });

  it('marks only the fields the schema requires as required', () => {
    const parameters = declarationParameters(complexSchema);

    expect([...(parameters.required ?? [])].sort()).toEqual(['id', 'title']);
  });

  it('carries the field defaults across', () => {
    const properties = declarationParameters(complexSchema).properties ?? {};

    expect(properties['tags'].default).toEqual([]);
    expect(properties['metadata'].default).toEqual({});
    expect(properties['isActive'].default).toBe(true);
  });

  it('preserves the field descriptions', () => {
    const properties = declarationParameters(personSchema).properties ?? {};

    expect(properties['name'].description).toBe("A person's name");
    expect(properties['age'].description).toBe("A person's age");
    expect(properties['city'].description).toBe('The city they live in');
  });

  it('preserves the descriptions of a nested object field', () => {
    const outputSchema = z.object({
      name: z.string().describe("A person's name"),
      address: subSchema.describe('Where they live'),
    });

    const properties = declarationParameters(outputSchema).properties ?? {};
    const address = properties['address'];

    expect(address.description).toBe('Where they live');
    expect(address.properties?.['field1'].description).toBe('Field 1');
    expect(address.properties?.['field2'].description).toBe('Field 2');
  });

  it('preserves the descriptions of the items of a list field', () => {
    const outputSchema = z.object({
      previousAddresses: z.array(subSchema).describe('Where they lived'),
    });

    const properties = declarationParameters(outputSchema).properties ?? {};
    const previousAddresses = properties['previousAddresses'];

    expect(previousAddresses.description).toBe('Where they lived');
    expect(previousAddresses.items?.properties?.['field1'].description).toBe(
      'Field 1',
    );
  });

  it('wraps a list of objects in a required items parameter', () => {
    const parameters = declarationParameters(z.array(itemSchema));

    expect(parameters.type).toBe(Type.OBJECT);
    expect(Object.keys(parameters.properties ?? {})).toEqual(['items']);
    expect(parameters.required).toEqual(['items']);
    const items = parameters.properties?.['items'];
    expect(items?.type).toBe(Type.ARRAY);
    expect(items?.items?.properties?.['id'].description).toBe('Item ID');
    expect(items?.items?.properties?.['name'].description).toBe('Item name');
  });

  it.each<[string, SchemaLike]>([
    ['a list of strings', z.array(z.string())],
    ['a record', z.record(z.string(), z.number())],
  ])('wraps %s in a required response parameter', (_label, outputSchema) => {
    const parameters = declarationParameters(outputSchema);

    expect(parameters.type).toBe(Type.OBJECT);
    expect(Object.keys(parameters.properties ?? {})).toEqual(['response']);
    expect(parameters.required).toEqual(['response']);
  });

  it('wraps a non-object genai Schema in a required response parameter', () => {
    const arraySchema: Schema = {
      type: Type.ARRAY,
      items: {type: Type.STRING},
    };

    const parameters = declarationParameters(arraySchema);

    expect(parameters.properties?.['response']).toEqual(arraySchema);
    expect(parameters.required).toEqual(['response']);
  });

  it('wraps a genai array of objects in a required items parameter', () => {
    const arraySchema: Schema = {
      type: Type.ARRAY,
      items: {type: Type.OBJECT, properties: {id: {type: Type.NUMBER}}},
    };

    const parameters = declarationParameters(arraySchema);

    expect(parameters.properties?.['items']).toEqual(arraySchema);
    expect(parameters.required).toEqual(['items']);
  });

  it('uses an object genai Schema as the parameters directly', () => {
    const tool = new SetModelResponseTool(rawGenaiSchema);

    const declaration = tool._getDeclaration();

    expect(declaration.name).toBe(SET_MODEL_RESPONSE_TOOL_NAME);
    expect(declaration.description).toBeTruthy();
    expect(declaration.parameters).toEqual(rawGenaiSchema);
  });

  it('keeps the properties of optional nested fields', () => {
    const outputSchema = z.object({
      nested: subSchema.optional().describe('Nested model'),
      nestedList: z.array(subSchema).optional().describe('Nested list'),
    });

    const properties = declarationParameters(outputSchema).properties ?? {};

    expect(properties['nested'].type).toBe(Type.OBJECT);
    expect(properties['nested'].properties?.['field1'].type).toBe(Type.STRING);
    expect(properties['nested'].properties?.['field2'].type).toBe(Type.NUMBER);
    expect(properties['nestedList'].type).toBe(Type.ARRAY);
    expect(properties['nestedList'].items?.properties?.['field1'].type).toBe(
      Type.STRING,
    );
  });

  it('wraps a Zod v3 list of objects in a required items parameter', () => {
    const v3ItemSchema = z3.object({
      id: z3.number().describe('Item ID'),
    });

    const parameters = declarationParameters(z3.array(v3ItemSchema));

    expect(Object.keys(parameters.properties ?? {})).toEqual(['items']);
    expect(parameters.required).toEqual(['items']);
    expect(
      parameters.properties?.['items'].items?.properties?.['id'].description,
    ).toBe('Item ID');
  });

  it('builds the declaration once, so it is stable across turns', () => {
    const tool = new SetModelResponseTool(personSchema);

    expect(tool._getDeclaration()).toEqual(tool._getDeclaration());
  });
});

describe('SetModelResponseTool runAsync', () => {
  it('returns the validated object and publishes it on the actions', async () => {
    const tool = new SetModelResponseTool(personSchema);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {name: 'Alice', age: 25, city: 'Seattle'},
      toolContext,
    });

    expect(result).toEqual({name: 'Alice', age: 25, city: 'Seattle'});
    expect(toolContext.actions.setModelResponse).toEqual(result);
  });

  it('accepts a complex schema with every field supplied', async () => {
    const tool = new SetModelResponseTool(complexSchema);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {
        id: 123,
        title: 'Test Item',
        tags: ['tag1', 'tag2'],
        metadata: {key: 'value'},
        isActive: false,
      },
      toolContext,
    });

    expect(result).toEqual({
      id: 123,
      title: 'Test Item',
      tags: ['tag1', 'tag2'],
      metadata: {key: 'value'},
      isActive: false,
    });
    expect(toolContext.actions.setModelResponse).toEqual(result);
  });

  it('accepts a complex schema with the defaulted fields omitted', async () => {
    const tool = new SetModelResponseTool(complexSchema);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {id: 1, title: 'Only the required fields'},
      toolContext,
    });

    expect(result).toEqual({
      id: 1,
      title: 'Only the required fields',
      tags: [],
      metadata: {},
      isActive: true,
    });
  });

  it('returns retry feedback when a field has the wrong type', async () => {
    const tool = new SetModelResponseTool(personSchema);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {name: 'Bob', age: 'not a number', city: 'Portland'},
      toolContext,
    });

    expect(result).toEqual({
      error: expect.stringContaining('Validation Error found'),
    });
    expect(result).toEqual({error: expect.stringContaining('age')});
    expect(result).toEqual({
      error: expect.stringContaining(
        'Recall the set_model_response function correctly, fix the errors,' +
          ' and call it again with all required fields using the correct types.',
      ),
    });
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('returns retry feedback when a required field is missing', async () => {
    const tool = new SetModelResponseTool(personSchema);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {name: 'Carol', city: 'Denver'},
      toolContext,
    });

    expect(result).toEqual({
      error: expect.stringContaining('Validation Error found'),
    });
    expect(result).toEqual({error: expect.stringContaining('age')});
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('returns the validated list for a list schema', async () => {
    const tool = new SetModelResponseTool(z.array(itemSchema));
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {
        items: [
          {id: 1, name: 'Item 1'},
          {id: 2, name: 'Item 2'},
          {id: 3, name: 'Item 3'},
        ],
      },
      toolContext,
    });

    expect(result).toEqual([
      {id: 1, name: 'Item 1'},
      {id: 2, name: 'Item 2'},
      {id: 3, name: 'Item 3'},
    ]);
    expect(toolContext.actions.setModelResponse).toEqual(result);
  });

  it('accepts an empty list', async () => {
    const tool = new SetModelResponseTool(z.array(itemSchema));
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {items: []}, toolContext});

    expect(result).toEqual([]);
    expect(toolContext.actions.setModelResponse).toEqual([]);
  });

  it('treats an omitted items argument as an empty list', async () => {
    const tool = new SetModelResponseTool(z.array(itemSchema));
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toEqual([]);
    expect(toolContext.actions.setModelResponse).toEqual([]);
  });

  it('names the failing element and field for a list schema', async () => {
    const tool = new SetModelResponseTool(z.array(itemSchema));
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {items: [{id: 'not a number', name: 'Item 1'}]},
      toolContext,
    });

    expect(result).toEqual({
      error: expect.stringContaining('Validation Error found'),
    });
    expect(result).toEqual({error: expect.stringContaining('0.id')});
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('unwraps a list of strings from the response argument', async () => {
    const tool = new SetModelResponseTool(z.array(z.string()));
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {response: ['apple', 'banana', 'cherry']},
      toolContext,
    });

    expect(result).toEqual(['apple', 'banana', 'cherry']);
    expect(toolContext.actions.setModelResponse).toEqual(result);
  });

  it('unwraps a record from the response argument', async () => {
    const tool = new SetModelResponseTool(z.record(z.string(), z.number()));
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {response: {a: 1, b: 2, c: 3}},
      toolContext,
    });

    expect(result).toEqual({a: 1, b: 2, c: 3});
  });

  it('returns retry feedback when a wrapped value fails validation', async () => {
    const tool = new SetModelResponseTool(z.array(z.string()));
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {response: [1, 2]},
      toolContext,
    });

    expect(result).toEqual({
      error: expect.stringContaining('Validation Error found'),
    });
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('validates a genai Schema and returns the value', async () => {
    const tool = new SetModelResponseTool(rawGenaiSchema);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {result: 'hello'},
      toolContext,
    });

    expect(result).toEqual({result: 'hello'});
    expect(toolContext.actions.setModelResponse).toEqual({result: 'hello'});
  });

  it('returns retry feedback when a genai Schema field has the wrong type', async () => {
    const tool = new SetModelResponseTool(rawGenaiSchema);
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {result: 5}, toolContext});

    expect(result).toEqual({
      error: expect.stringContaining('Validation Error found'),
    });
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('overwrites the published value on a second call', async () => {
    const tool = new SetModelResponseTool(personSchema);
    const toolContext = createToolContext();

    const first = await tool.runAsync({
      args: {name: 'First', age: 20, city: 'City1'},
      toolContext,
    });
    expect(toolContext.actions.setModelResponse).toEqual(first);

    const second = await tool.runAsync({
      args: {name: 'Second', age: 30, city: 'City2'},
      toolContext,
    });

    expect(first).toEqual({name: 'First', age: 20, city: 'City1'});
    expect(second).toEqual({name: 'Second', age: 30, city: 'City2'});
    expect(toolContext.actions.setModelResponse).toEqual(second);
  });

  it('leaves the published value alone when a retry fails', async () => {
    const tool = new SetModelResponseTool(personSchema);
    const toolContext = createToolContext();

    const valid = await tool.runAsync({
      args: {name: 'First', age: 20, city: 'City1'},
      toolContext,
    });
    await tool.runAsync({args: {name: 'Second'}, toolContext});

    expect(toolContext.actions.setModelResponse).toEqual(valid);
  });
});
