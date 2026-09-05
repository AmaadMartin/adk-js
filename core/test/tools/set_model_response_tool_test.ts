/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
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
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

function createToolContext(): Context {
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
    const toolContext = createToolContext();

    const result = await createTool(PERSON_SCHEMA).runAsync({
      args: {name: 'Alice', age: 25, tags: ['friend']},
      toolContext,
    });

    expect(result).toEqual({name: 'Alice', age: 25, tags: ['friend']});
    expect(toolContext.actions.setModelResponse).toEqual(result);
  });

  it('applies a declared default for an omitted field', async () => {
    const toolContext = createToolContext();

    const result = await createTool(PERSON_SCHEMA).runAsync({
      args: {name: 'Alice', age: 25},
      toolContext,
    });

    expect(result).toEqual({name: 'Alice', age: 25, tags: []});
    expect(toolContext.actions.setModelResponse).toEqual(result);
  });

  it('reports a wrong field type and records nothing', async () => {
    const toolContext = createToolContext();

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
    const toolContext = createToolContext();

    const result = await createTool(PERSON_SCHEMA).runAsync({
      args: {name: 'Bob'},
      toolContext,
    });

    expect(result).toEqual({error: expect.stringContaining('age')});
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('returns the validated list submitted under items', async () => {
    const toolContext = createToolContext();

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
    const toolContext = createToolContext();

    const result = await createTool(PEOPLE_LIST_SCHEMA).runAsync({
      args: {},
      toolContext,
    });

    expect(result).toEqual([]);
    expect(toolContext.actions.setModelResponse).toEqual([]);
  });

  it('reports the index and field of an invalid list item', async () => {
    const toolContext = createToolContext();

    const result = await createTool(PEOPLE_LIST_SCHEMA).runAsync({
      args: {
        items: [
          {id: 1, name: 'Alice'},
          {id: 'two', name: 'Bob'},
        ],
      },
      toolContext,
    });

    expect(result).toEqual({
      error: expect.stringMatching(/"path": \[\s*1,\s*"id"/),
    });
    expect(toolContext.actions.setModelResponse).toBeUndefined();
  });

  it('returns a list of primitives submitted under response', async () => {
    const toolContext = createToolContext();

    const result = await createTool(z4.array(z4.string())).runAsync({
      args: {response: ['a', 'b']},
      toolContext,
    });

    expect(result).toEqual(['a', 'b']);
    expect(toolContext.actions.setModelResponse).toEqual(['a', 'b']);
  });

  it('returns a record submitted under response', async () => {
    const toolContext = createToolContext();

    const result = await createTool(
      z4.record(z4.string(), z4.number()),
    ).runAsync({args: {response: {a: 1, b: 2}}, toolContext});

    expect(result).toEqual({a: 1, b: 2});
  });

  it('rejects a missing response argument against a required schema', async () => {
    const toolContext = createToolContext();

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
    const toolContext = createToolContext();
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
    const toolContext = createToolContext();

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
    const toolContext = createToolContext();

    const result = await createTool(
      z4.object({nickname: z4.string().nullable()}),
    ).runAsync({args: {nickname: null}, toolContext});

    expect(result).toEqual({nickname: null});
  });

  it('keeps a Date a coercing schema produced', async () => {
    const toolContext = createToolContext();

    const result = await createTool(z4.coerce.date()).runAsync({
      args: {response: '2026-01-02T03:04:05.000Z'},
      toolContext,
    });

    expect(JSON.stringify(result)).toBe('"2026-01-02T03:04:05.000Z"');
  });

  it('reports a schema check that throws a non-Error value', async () => {
    const toolContext = createToolContext();
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
    const toolContext = createToolContext();
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
