/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from google/adk-python
 * tests/unittests/tools/test_set_model_response_tool.py (branch main).
 *
 * Each `it` title is the Python test function name, so a reader can find the
 * original by grepping for it.
 */

import {
  Context,
  createSession,
  InvocationContext,
  PluginManager,
  SchemaLike,
  SetModelResponseTool,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
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

/**
 * Python's `raw_schema` / `types.Schema` fixtures. adk-js treats a genai
 * `Schema` as a first-class schema form, so both Python fixtures collapse to
 * one here.
 */
const rawGenaiSchema: Schema = {
  type: Type.OBJECT,
  properties: {result: {type: Type.STRING}},
};

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-id',
      session: createSession({id: 'test-session', appName: 'test_app'}),
      pluginManager: new PluginManager([]),
    }),
  });
}

function declarationParameters(outputSchema: SchemaLike): Schema {
  const parameters = new SetModelResponseTool(outputSchema)._getDeclaration()
    .parameters;
  if (!parameters) {
    expect.fail('the tool declared no parameters');
  }
  return parameters;
}

function properties(schema: Schema): Record<string, Schema> {
  if (!schema.properties) {
    expect.fail('the schema declared no properties');
  }
  return schema.properties;
}

describe('SetModelResponseTool initialization', () => {
  it('test_tool_initialization_simple_schema', () => {
    const tool = new SetModelResponseTool(personSchema);

    expect(tool.name).toBe('set_model_response');
    expect(tool.description).toContain('Set your final response');
  });

  it('test_tool_initialization_complex_schema', () => {
    const tool = new SetModelResponseTool(complexSchema);

    expect(tool.name).toBe('set_model_response');
    expect(tool.description).toContain('Set your final response');
  });

  it('test_tool_initialization_list_schema', () => {
    const tool = new SetModelResponseTool(z.array(itemSchema));

    expect(tool.name).toBe('set_model_response');
    expect(tool.description).toContain('Set your final response');
    expect(
      properties(declarationParameters(z.array(itemSchema))),
    ).toHaveProperty('items');
  });

  it('test_tool_initialization_list_str_schema', () => {
    const tool = new SetModelResponseTool(z.array(z.string()));

    expect(tool.name).toBe('set_model_response');
    expect(
      properties(declarationParameters(z.array(z.string()))),
    ).toHaveProperty('response');
  });

  it('test_tool_initialization_dict_schema', () => {
    const schema = z.record(z.string(), z.number());
    const tool = new SetModelResponseTool(schema);

    expect(tool.name).toBe('set_model_response');
    expect(properties(declarationParameters(schema))).toHaveProperty(
      'response',
    );
  });

  it('test_tool_initialization_raw_dict_schema', () => {
    const tool = new SetModelResponseTool(rawGenaiSchema);

    expect(tool.name).toBe('set_model_response');
    expect(tool.description).toContain('Set your final response');
  });

  it('test_tool_initialization_schema_instance', () => {
    // Divergence: Python converts a `types.Schema` to a raw dict and routes it
    // through the unvalidated `response` wrapper. adk-js uses an object-typed
    // genai `Schema` as the parameters directly.
    const declaration = new SetModelResponseTool(
      rawGenaiSchema,
    )._getDeclaration();

    expect(declaration.name).toBe('set_model_response');
    expect(declarationParameters(rawGenaiSchema)).toEqual(rawGenaiSchema);
  });
});

describe('SetModelResponseTool declaration', () => {
  it('test_get_declaration', () => {
    const declaration = new SetModelResponseTool(
      personSchema,
    )._getDeclaration();

    expect(declaration.name).toBe('set_model_response');
    expect(declaration.description).toBeTruthy();
  });

  it('test_get_declaration_marks_only_schema_required_fields_required', () => {
    const parameters = declarationParameters(complexSchema);

    expect(parameters.required?.slice().sort()).toEqual(['id', 'title']);
  });

  it('test_get_declaration_preserves_field_defaults', () => {
    const fields = properties(declarationParameters(complexSchema));

    expect(fields['tags'].default).toEqual([]);
    expect(fields['metadata'].default).toEqual({});
    expect(fields['isActive'].default).toBe(true);
  });

  it('test_get_declaration_preserves_field_descriptions', () => {
    const fields = properties(declarationParameters(personSchema));

    expect(fields['name'].description).toBe("A person's name");
    expect(fields['age'].description).toBe("A person's age");
    expect(fields['city'].description).toBe('The city they live in');
  });

  it('test_get_declaration_preserves_nested_basemodel_field_descriptions', () => {
    const address = z.object({
      street: z.string().describe('Street address'),
      city: z.string().describe('City name'),
    });
    const user = z.object({
      name: z.string().describe("User's name"),
      address: address.describe("User's address"),
      previousAddresses: z
        .array(address)
        .default([])
        .describe('Past addresses'),
    });

    const fields = properties(declarationParameters(user));

    expect(fields['name'].description).toBe("User's name");
    expect(fields['address'].description).toBe("User's address");
    expect(fields['previousAddresses'].description).toBe('Past addresses');
    const addressFields = properties(fields['address']);
    expect(addressFields['street'].description).toBe('Street address');
    expect(addressFields['city'].description).toBe('City name');
    const itemFields = properties(fields['previousAddresses'].items!);
    expect(itemFields['street'].description).toBe('Street address');
    expect(itemFields['city'].description).toBe('City name');
  });

  it('test_get_declaration_preserves_list_item_field_descriptions', () => {
    const fields = properties(declarationParameters(z.array(itemSchema)));
    const itemFields = properties(fields['items'].items!);

    expect(itemFields['id'].description).toBe('Item ID');
    expect(itemFields['name'].description).toBe('Item name');
  });

  it('test_get_declaration_list_schema', () => {
    const declaration = new SetModelResponseTool(
      z.array(itemSchema),
    )._getDeclaration();

    expect(declaration.name).toBe('set_model_response');
    expect(declaration.description).toBeTruthy();
  });

  it('test_get_declaration_raw_dict_schema', () => {
    const declaration = new SetModelResponseTool(
      rawGenaiSchema,
    )._getDeclaration();

    expect(declaration.name).toBe('set_model_response');
    expect(declaration.description).toBeTruthy();
  });

  it('test_get_declaration_optional_fields', () => {
    const optionalSchema = z.object({
      nested: subSchema.nullish().describe('Nested model'),
      nestedList: z
        .array(subSchema)
        .nullish()
        .describe('Nested list of models'),
      rawList: z.array(z.unknown()).nullish().describe('Raw list'),
    });

    const parameters = declarationParameters(optionalSchema);
    const fields = properties(parameters);

    expect(parameters.type).toBe(Type.OBJECT);
    const nestedFields = properties(fields['nested']);
    expect(nestedFields['field1'].type).toBe(Type.STRING);
    expect(nestedFields['field2'].type).toBe(Type.NUMBER);
    expect(fields['nestedList'].type).toBe(Type.ARRAY);
    const listItemFields = properties(fields['nestedList'].items!);
    expect(listItemFields['field1'].type).toBe(Type.STRING);
    expect(listItemFields['field2'].type).toBe(Type.NUMBER);
    expect(fields['rawList'].type).toBe(Type.ARRAY);
  });
});

describe('SetModelResponseTool runAsync', () => {
  it('test_run_async_valid_data', async () => {
    const tool = new SetModelResponseTool(personSchema);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {name: 'Alice', age: 25, city: 'Seattle'},
      toolContext,
    });

    expect(result).toEqual({name: 'Alice', age: 25, city: 'Seattle'});
  });

  it('test_run_async_complex_schema', async () => {
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

  it('test_run_async_validation_error', async () => {
    const tool = new SetModelResponseTool(personSchema);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {name: 'Bob', age: 'not_a_number', city: 'Portland'},
      toolContext,
    });

    expect(result).toHaveProperty('error');
    const {error} = result as {error: string};
    expect(error).toContain('Validation Error found');
    expect(error).toContain('age');
    expect(error).toContain('expected number');
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('test_run_async_missing_required_field', async () => {
    const tool = new SetModelResponseTool(personSchema);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {name: 'Charlie', city: 'Denver'},
      toolContext,
    });

    expect(result).toHaveProperty('error');
    const {error} = result as {error: string};
    expect(error).toContain('Validation Error found');
    expect(error).toContain('age');
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('test_session_state_storage_key', async () => {
    const tool = new SetModelResponseTool(personSchema);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {name: 'Diana', age: 35, city: 'Miami'},
      toolContext,
    });

    expect(result).toEqual({name: 'Diana', age: 35, city: 'Miami'});
    expect(toolContext.actions.setModelResponse).toEqual(result);
    expect(toolContext.state.get('set_model_response')).toBeUndefined();
  });

  it('test_multiple_executions_return_latest', async () => {
    const tool = new SetModelResponseTool(personSchema);
    const toolContext = createToolContext();

    const first = await tool.runAsync({
      args: {name: 'First', age: 20, city: 'City1'},
      toolContext,
    });
    const second = await tool.runAsync({
      args: {name: 'Second', age: 30, city: 'City2'},
      toolContext,
    });

    expect(first).toEqual({name: 'First', age: 20, city: 'City1'});
    expect(second).toEqual({name: 'Second', age: 30, city: 'City2'});
    expect(toolContext.actions.setModelResponse).toEqual(second);
  });

  it('test_run_async_list_schema_valid_data', async () => {
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
  });

  it('test_run_async_list_schema_empty_list', async () => {
    const tool = new SetModelResponseTool(z.array(itemSchema));
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {items: []}, toolContext});

    expect(result).toEqual([]);
    expect(toolContext.actions.setModelResponse).toEqual(result);
  });

  it('test_run_async_list_schema_validation_error', async () => {
    const tool = new SetModelResponseTool(z.array(itemSchema));
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {items: [{id: 'not_a_number', name: 'Item 1'}]},
      toolContext,
    });

    expect(result).toHaveProperty('error');
    const {error} = result as {error: string};
    expect(error).toContain('Validation Error found');
    expect(error).toContain('0.id');
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('test_run_async_list_str_schema', async () => {
    const tool = new SetModelResponseTool(z.array(z.string()));
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {response: ['apple', 'banana', 'cherry']},
      toolContext,
    });

    expect(result).toEqual(['apple', 'banana', 'cherry']);
  });

  it('test_run_async_dict_schema', async () => {
    const tool = new SetModelResponseTool(z.record(z.string(), z.number()));
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {response: {a: 1, b: 2, c: 3}},
      toolContext,
    });

    expect(result).toEqual({a: 1, b: 2, c: 3});
  });

  it('test_run_async_raw_dict_schema', async () => {
    // Divergence: the genai `Schema` is the parameters here, so the model fills
    // the fields in directly rather than through a `response` wrapper.
    const tool = new SetModelResponseTool(rawGenaiSchema);
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {result: 'hello'},
      toolContext,
    });

    expect(result).toEqual({result: 'hello'});
  });
});
