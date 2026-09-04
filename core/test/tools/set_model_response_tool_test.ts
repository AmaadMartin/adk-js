/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  Context,
  createEvent,
  createEventActions,
  createSession,
  createSetModelResponseTool,
  getStructuredModelResponse,
  InvocationContext,
  LlmAgent,
  PluginManager,
  SchemaLike,
  SET_MODEL_RESPONSE_TOOL_NAME,
  SetModelResponseTool,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z, z as z4} from 'zod/v4';

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

const FACTORY_OUTPUT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {answer: {type: Type.STRING}},
};

function createFactoryToolContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext});
}

/** The validator an agent declaring `FACTORY_OUTPUT_SCHEMA` in Zod would supply. */
const validateOutput = (value: unknown): unknown =>
  z.object({answer: z.string()}).parse(value);

describe('createSetModelResponseTool', () => {
  it('declares the output schema as its parameters', () => {
    const tool = createSetModelResponseTool(
      FACTORY_OUTPUT_SCHEMA,
      validateOutput,
    );

    expect(tool.name).toBe('set_model_response');
    expect(tool._getDeclaration()?.name).toBe('set_model_response');
    expect(tool._getDeclaration()?.parameters).toEqual(FACTORY_OUTPUT_SCHEMA);
  });

  it('records a valid answer on the actions and returns it', async () => {
    const tool = createSetModelResponseTool(
      FACTORY_OUTPUT_SCHEMA,
      validateOutput,
    );
    const toolContext = createFactoryToolContext();

    const result = await tool.runAsync({
      args: {answer: 'forty two'},
      toolContext,
    });

    expect(result).toEqual({answer: 'forty two'});
    expect(toolContext.actions.setModelResponse).toEqual({
      answer: 'forty two',
    });
  });

  it('reports a schema violation to the model and records nothing', async () => {
    const tool = createSetModelResponseTool(
      FACTORY_OUTPUT_SCHEMA,
      validateOutput,
    );
    const toolContext = createFactoryToolContext();

    const result = await tool.runAsync({args: {answer: 42}, toolContext});

    expect(result).toMatchObject({
      error: expect.stringContaining('Validation Error found:'),
    });
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('reports a validator that throws a non-Error value', async () => {
    const tool = createSetModelResponseTool(FACTORY_OUTPUT_SCHEMA, () => {
      throw 'answer is required';
    });
    const toolContext = createFactoryToolContext();

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toEqual({
      error:
        'Validation Error found:\nanswer is required\nRecall the set_model_response function correctly, fix the errors, and call it again with all required fields using the correct types.',
    });
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('leaves summarization enabled, so the flow decides what follows', async () => {
    const tool = createSetModelResponseTool(
      FACTORY_OUTPUT_SCHEMA,
      validateOutput,
    );
    const toolContext = createFactoryToolContext();

    await tool.runAsync({args: {answer: 'forty two'}, toolContext});

    expect(toolContext.actions.skipSummarization).toBeUndefined();
  });
});

/**
 * The suite that arrived with the `set_model_response` validation and retry
 * change. It exercises the same tool through the functional form.
 */
function createAgentToolContext(): Context {
  const agent = new LlmAgent({name: 'test_agent'});
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv_123',
      agent,
      session: createSession({
        id: 'sess_123',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager(),
    }),
  });
}

/** Builds the tool the way `LlmAgent` does: over the schema as supplied. */
function createTool(outputSchema: SchemaLike) {
  return createSetModelResponseTool(outputSchema);
}

const PERSON_SCHEMA = z4.object({
  name: z4.string().describe("A person's name"),
  age: z4.number(),
  nickname: z4.string().optional(),
  tags: z4.array(z4.string()).default([]),
});

const PERSON_GENAI_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    name: {type: Type.STRING},
    age: {type: Type.INTEGER},
  },
  required: ['name', 'age'],
};

const PEOPLE_LIST_SCHEMA = z4.array(
  z4.object({id: z4.number(), name: z4.string()}),
);

describe('createSetModelResponseTool declaration', () => {
  it('exposes the output schema fields for a Zod object schema', () => {
    const declaration = createTool(PERSON_SCHEMA)._getDeclaration();

    expect(declaration.name).toBe(SET_MODEL_RESPONSE_TOOL_NAME);
    expect(declaration.parameters?.type).toBe(Type.OBJECT);
    expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
      'name',
      'age',
      'nickname',
      'tags',
    ]);
  });

  it('passes a genai object Schema through unchanged', () => {
    const declaration = createTool(PERSON_GENAI_SCHEMA)._getDeclaration();

    expect(declaration.parameters).toBe(PERSON_GENAI_SCHEMA);
  });

  it('marks only the schema-required fields as required', () => {
    const declaration = createTool(PERSON_SCHEMA)._getDeclaration();

    expect(declaration.parameters?.required).toEqual(['name', 'age']);
  });

  it('preserves a field default', () => {
    const declaration = createTool(PERSON_SCHEMA)._getDeclaration();

    expect(declaration.parameters?.properties?.['tags'].default).toEqual([]);
  });

  it('preserves field descriptions, including nested ones', () => {
    const schema = z4.object({
      name: z4.string().describe("A person's name"),
      address: z4.object({city: z4.string().describe('City of residence')}),
    });

    const declaration = createTool(schema)._getDeclaration();

    expect(declaration.parameters?.properties?.['name'].description).toBe(
      "A person's name",
    );
    expect(
      declaration.parameters?.properties?.['address'].properties?.['city']
        .description,
    ).toBe('City of residence');
  });

  it('wraps a list-of-object schema in a single items parameter', () => {
    const declaration = createTool(PEOPLE_LIST_SCHEMA)._getDeclaration();

    expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
      'items',
    ]);
    expect(declaration.parameters?.required).toEqual(['items']);
    const items = declaration.parameters?.properties?.['items'];
    expect(items?.type).toBe(Type.ARRAY);
    expect(Object.keys(items?.items?.properties ?? {})).toEqual(['id', 'name']);
  });

  it('wraps a list-of-primitive schema in a single response parameter', () => {
    const declaration = createTool(z4.array(z4.string()))._getDeclaration();

    expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
      'response',
    ]);
    expect(declaration.parameters?.properties?.['response'].type).toBe(
      Type.ARRAY,
    );
  });

  it('wraps a record schema in a single response parameter', () => {
    const declaration = createTool(
      z4.record(z4.string(), z4.number()),
    )._getDeclaration();

    expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
      'response',
    ]);
  });

  it('wraps a Zod v3 schema in the v3 dialect', () => {
    const declaration = createTool(
      z3.array(z3.string().describe('a tag')),
    )._getDeclaration();

    const response = declaration.parameters?.properties?.['response'];
    expect(response?.type).toBe(Type.ARRAY);
    expect(response?.items?.description).toBe('a tag');
  });

  it('wraps a genai primitive Schema in a single response parameter', () => {
    const schema: Schema = {type: Type.STRING};

    const declaration = createTool(schema)._getDeclaration();

    expect(declaration.parameters?.properties?.['response']).toBe(schema);
    expect(declaration.parameters?.required).toEqual(['response']);
  });

  it('wraps an object schema that is not a Zod object in a response parameter', () => {
    const declaration = createTool(
      z4.object({name: z4.string()}).optional(),
    )._getDeclaration();

    expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
      'response',
    ]);
  });

  it('leaves the parameter unconstrained for a schema genai cannot express', () => {
    const declaration = createTool(z4.coerce.date())._getDeclaration();

    expect(declaration.parameters?.properties?.['response']).toEqual({});
    expect(declaration.parameters?.required).toEqual(['response']);
  });
});

describe('createSetModelResponseTool execution', () => {
  it('returns the validated object and records it on the actions', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(PERSON_SCHEMA).runAsync({
      args: {name: 'Alice', age: 25, tags: ['friend']},
      toolContext,
    });

    expect(result).toEqual({name: 'Alice', age: 25, tags: ['friend']});
    expect(toolContext.actions.setModelResponse).toEqual(result);
  });

  it('applies a declared default for an omitted field', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(PERSON_SCHEMA).runAsync({
      args: {name: 'Alice', age: 25},
      toolContext,
    });

    expect(result).toEqual({name: 'Alice', age: 25, tags: []});
    expect(toolContext.actions.setModelResponse).toEqual(result);
  });

  it('reports a wrong field type and records nothing', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(PERSON_SCHEMA).runAsync({
      args: {name: 'Bob', age: 'not a number'},
      toolContext,
    });

    expect(result).toEqual({
      error: expect.stringContaining('Validation Error found:'),
    });
    expect(result).toEqual({error: expect.stringContaining('age')});
    expect(result).toEqual({
      error: expect.stringContaining(
        `Recall the ${SET_MODEL_RESPONSE_TOOL_NAME} function correctly, fix ` +
          'the errors, and call it again with all required fields using the ' +
          'correct types.',
      ),
    });
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('reports a missing required field', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(PERSON_SCHEMA).runAsync({
      args: {name: 'Bob'},
      toolContext,
    });

    expect(result).toEqual({error: expect.stringContaining('age')});
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('returns the validated list submitted under items', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(PEOPLE_LIST_SCHEMA).runAsync({
      args: {
        items: [
          {id: 1, name: 'Alice'},
          {id: 2, name: 'Bob'},
        ],
      },
      toolContext,
    });

    expect(result).toEqual([
      {id: 1, name: 'Alice'},
      {id: 2, name: 'Bob'},
    ]);
    expect(toolContext.actions.setModelResponse).toEqual(result);
  });

  it('treats an absent items argument as an empty list', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(PEOPLE_LIST_SCHEMA).runAsync({
      args: {},
      toolContext,
    });

    expect(result).toEqual([]);
    expect(toolContext.actions.setModelResponse).toEqual([]);
  });

  it('reports the index and field of an invalid list item', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(PEOPLE_LIST_SCHEMA).runAsync({
      args: {
        items: [
          {id: 1, name: 'Alice'},
          {id: 'two', name: 'Bob'},
        ],
      },
      toolContext,
    });

    // `formatSchemaValidationError` renders one `path: message` line per
    // issue, so the index and the field arrive as `1.id`.
    expect(result).toEqual({
      error: expect.stringContaining('1.id'),
    });
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('returns a list of primitives submitted under response', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(z4.array(z4.string())).runAsync({
      args: {response: ['a', 'b']},
      toolContext,
    });

    expect(result).toEqual(['a', 'b']);
    expect(toolContext.actions.setModelResponse).toEqual(['a', 'b']);
  });

  it('returns a record submitted under response', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(
      z4.record(z4.string(), z4.number()),
    ).runAsync({args: {response: {a: 1, b: 2}}, toolContext});

    expect(result).toEqual({a: 1, b: 2});
  });

  it('rejects a missing response argument against a required schema', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(z4.array(z4.string())).runAsync({
      args: {},
      toolContext,
    });

    expect(result).toEqual({
      error: expect.stringContaining('Validation Error found:'),
    });
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('keeps the value of the latest call on the actions', async () => {
    const toolContext = createAgentToolContext();
    const tool = createTool(PERSON_SCHEMA);

    const first = await tool.runAsync({
      args: {name: 'Alice', age: 25},
      toolContext,
    });
    const second = await tool.runAsync({
      args: {name: 'Bob', age: 30},
      toolContext,
    });

    expect(first).toEqual({name: 'Alice', age: 25, tags: []});
    expect(second).toEqual({name: 'Bob', age: 30, tags: []});
    expect(toolContext.actions.setModelResponse).toEqual(second);
  });

  it('omits a key whose validated value is undefined', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(PERSON_SCHEMA).runAsync({
      args: {name: 'Alice', age: 25, nickname: undefined},
      toolContext,
    });

    expect(result).toEqual({name: 'Alice', age: 25, tags: []});
    expect(Object.keys(result as Record<string, unknown>)).not.toContain(
      'nickname',
    );
  });

  it('keeps an explicit null a nullable field declares', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(
      z4.object({nickname: z4.string().nullable()}),
    ).runAsync({args: {nickname: null}, toolContext});

    expect(result).toEqual({nickname: null});
  });

  it('keeps a Date a coercing schema produced', async () => {
    const toolContext = createAgentToolContext();

    const result = await createTool(z4.coerce.date()).runAsync({
      args: {response: '2026-01-02T03:04:05.000Z'},
      toolContext,
    });

    expect(JSON.stringify(result)).toBe('"2026-01-02T03:04:05.000Z"');
  });

  it('reports a schema check that throws a non-Error value', async () => {
    const toolContext = createAgentToolContext();
    const throwingSchema = z4.object({name: z4.string()}).refine(() => {
      throw 'schema backend unavailable';
    });

    const result = await createTool(throwingSchema).runAsync({
      args: {name: 'Alice'},
      toolContext,
    });

    expect(result).toEqual({
      error: expect.stringContaining('schema backend unavailable'),
    });
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('reports an Error message without its class name', async () => {
    const toolContext = createAgentToolContext();
    const throwingSchema = z4.object({name: z4.string()}).refine(() => {
      throw new Error('schema backend unavailable');
    });

    const result = await createTool(throwingSchema).runAsync({
      args: {name: 'Alice'},
      toolContext,
    });

    expect(result).toEqual({
      error: expect.stringContaining(
        'Validation Error found:\nschema backend unavailable\n',
      ),
    });
  });
});

describe('getStructuredModelResponse', () => {
  function createFunctionResponseEvent(options: {
    toolName: string;
    setModelResponse?: unknown;
  }) {
    return createEvent({
      author: 'test_agent',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: options.toolName,
              response: {result: 'ok'},
            },
          },
        ],
      },
      actions: createEventActions({
        setModelResponse: options.setModelResponse,
      }),
    });
  }

  it('returns the recorded response as JSON', () => {
    const event = createFunctionResponseEvent({
      toolName: SET_MODEL_RESPONSE_TOOL_NAME,
      setModelResponse: {name: 'Alice', age: 25},
    });

    expect(getStructuredModelResponse(event)).toBe('{"name":"Alice","age":25}');
  });

  it('returns undefined when the call was rejected', () => {
    const event = createFunctionResponseEvent({
      toolName: SET_MODEL_RESPONSE_TOOL_NAME,
    });

    expect(getStructuredModelResponse(event)).toBeUndefined();
  });

  it('returns undefined when the recorded response is null', () => {
    const event = createFunctionResponseEvent({
      toolName: SET_MODEL_RESPONSE_TOOL_NAME,
      setModelResponse: null,
    });

    expect(getStructuredModelResponse(event)).toBeUndefined();
  });

  it('returns undefined when the response belongs to another tool', () => {
    const event = createFunctionResponseEvent({
      toolName: 'some_tool',
      setModelResponse: {name: 'Alice'},
    });

    expect(getStructuredModelResponse(event)).toBeUndefined();
  });
});
