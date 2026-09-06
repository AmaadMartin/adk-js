/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour adk-python gets from pydantic and its declaration builder, which
 * adk-js has to implement: the reference description, the variant-aware
 * declaration, `model_dump(exclude_none=True)`, and the unvalidated
 * pass-through for a schema that is neither an object nor a list of objects.
 *
 * It also covers the schema dialects adk-js accepts and adk-python has no
 * counterpart for, since the wrapper parameter is built per dialect.
 */

import {
  Context,
  createSession,
  InvocationContext,
  PluginManager,
  SetModelResponseTool,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';
import {z} from 'zod/v4';

const ENTERPRISE_MODE_ENV_VAR = 'GOOGLE_GENAI_USE_ENTERPRISE';

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-id',
      session: createSession({id: 'test-session', appName: 'test_app'}),
      pluginManager: new PluginManager([]),
    }),
  });
}

function properties(schema: Schema | undefined): Record<string, Schema> {
  if (!schema?.properties) {
    expect.fail('the schema declared no properties');
  }
  return schema.properties;
}

describe('SetModelResponseTool description', () => {
  it('reproduces the reference docstring', () => {
    const tool = new SetModelResponseTool(z.object({a: z.string()}));

    expect(tool.description).toBe(
      'Set your final response using the required output schema.\n\n' +
        'Use this tool to provide your final structured answer instead of ' +
        'outputting text directly.',
    );
  });
});

describe('SetModelResponseTool declaration per API variant', () => {
  const formattedSchema = z.object({
    contact: z.email(),
    seenAt: z.iso.datetime(),
  });
  let previousEnterpriseMode: string | undefined;

  beforeEach(() => {
    previousEnterpriseMode = process.env[ENTERPRISE_MODE_ENV_VAR];
  });

  afterEach(() => {
    if (previousEnterpriseMode === undefined) {
      delete process.env[ENTERPRISE_MODE_ENV_VAR];
    } else {
      process.env[ENTERPRISE_MODE_ENV_VAR] = previousEnterpriseMode;
    }
  });

  it('declares a string response schema on Vertex AI', () => {
    process.env[ENTERPRISE_MODE_ENV_VAR] = 'true';

    const declaration = new SetModelResponseTool(
      formattedSchema,
    )._getDeclaration();

    expect(declaration.response).toEqual({type: Type.STRING});
  });

  it('declares no response schema on the Gemini API', () => {
    process.env[ENTERPRISE_MODE_ENV_VAR] = 'false';

    const declaration = new SetModelResponseTool(
      formattedSchema,
    )._getDeclaration();

    expect(declaration.response).toBeUndefined();
  });

  it('keeps every format on Vertex AI', () => {
    process.env[ENTERPRISE_MODE_ENV_VAR] = 'true';

    const fields = properties(
      new SetModelResponseTool(formattedSchema)._getDeclaration().parameters,
    );

    expect(fields['contact'].format).toBe('email');
    expect(fields['seenAt'].format).toBe('date-time');
  });

  it('drops a format the Gemini API rejects', () => {
    process.env[ENTERPRISE_MODE_ENV_VAR] = 'false';

    const fields = properties(
      new SetModelResponseTool(formattedSchema)._getDeclaration().parameters,
    );

    expect(fields['contact'].format).toBeUndefined();
    expect(fields['seenAt'].format).toBe('date-time');
  });

  it('rebuilds the declaration when the variant changes', () => {
    const tool = new SetModelResponseTool(formattedSchema);

    process.env[ENTERPRISE_MODE_ENV_VAR] = 'false';
    const gemini = tool._getDeclaration();
    process.env[ENTERPRISE_MODE_ENV_VAR] = 'true';
    const vertex = tool._getDeclaration();

    expect(properties(gemini.parameters)['contact'].format).toBeUndefined();
    expect(properties(vertex.parameters)['contact'].format).toBe('email');
  });

  it('returns an equal declaration on repeated calls under one variant', () => {
    process.env[ENTERPRISE_MODE_ENV_VAR] = 'false';
    const tool = new SetModelResponseTool(formattedSchema);

    expect(tool._getDeclaration()).toEqual(tool._getDeclaration());
  });
});

describe('SetModelResponseTool null stripping', () => {
  it('drops a null field from an object response', async () => {
    const tool = new SetModelResponseTool(
      z.object({a: z.number(), b: z.string().nullable()}),
    );
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {a: 1, b: null}, toolContext});

    expect(result).toEqual({a: 1});
    expect(toolContext.actions.setModelResponse).toEqual({a: 1});
  });

  it('drops a null field from every element of a list response', async () => {
    const tool = new SetModelResponseTool(
      z.array(z.object({id: z.number(), note: z.string().nullable()})),
    );
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {
        items: [
          {id: 1, note: null},
          {id: 2, note: 'kept'},
        ],
      },
      toolContext,
    });

    expect(result).toEqual([{id: 1}, {id: 2, note: 'kept'}]);
  });

  it('keeps the null entries of an array field', async () => {
    const tool = new SetModelResponseTool(
      z.object({tags: z.array(z.string().nullable())}),
    );
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {tags: ['a', null, 'b']},
      toolContext,
    });

    expect(result).toEqual({tags: ['a', null, 'b']});
  });

  it('drops a null field nested inside an object field', async () => {
    const tool = new SetModelResponseTool(
      z.object({inner: z.object({a: z.number(), b: z.null()})}),
    );
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {inner: {a: 1, b: null}},
      toolContext,
    });

    expect(result).toEqual({inner: {a: 1}});
  });

  it('keeps a class instance a validator produced', async () => {
    const tool = new SetModelResponseTool(
      z.object({site: z.string().transform((value) => new URL(value))}),
    );
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {site: 'https://example.com/a'},
      toolContext,
    });

    // A URL has no own enumerable keys, so rebuilding it would empty it.
    expect((result as {site: URL}).site).toBeInstanceOf(URL);
    expect((result as {site: URL}).site.href).toBe('https://example.com/a');
  });
});

describe('SetModelResponseTool raw pass-through', () => {
  it('returns an array of primitives without validating it', async () => {
    const tool = new SetModelResponseTool(z.array(z.string()));
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {response: [1, 2]}, toolContext});

    expect(result).toEqual([1, 2]);
    expect(toolContext.actions.setModelResponse).toEqual([1, 2]);
  });

  it('returns a record without validating it', async () => {
    const tool = new SetModelResponseTool(z.record(z.string(), z.number()));
    const toolContext = createToolContext();

    const result = await tool.runAsync({
      args: {response: {a: 'not_a_number'}},
      toolContext,
    });

    expect(result).toEqual({a: 'not_a_number'});
    expect(toolContext.actions.setModelResponse).toEqual({a: 'not_a_number'});
  });

  it('publishes undefined when the model omits the response parameter', async () => {
    const tool = new SetModelResponseTool(z.array(z.string()));
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toBeUndefined();
    expect('setModelResponse' in toolContext.actions).toBe(true);
  });
});

describe('SetModelResponseTool wrapper parameter per schema dialect', () => {
  it('wraps a Zod v4 list of primitives under response', () => {
    const fields = properties(
      new SetModelResponseTool(z.array(z.string()))._getDeclaration()
        .parameters,
    );

    expect(fields['response'].type).toBe(Type.ARRAY);
    expect(fields['response'].items?.type).toBe(Type.STRING);
  });

  it('wraps a Zod v3 list of primitives under response', async () => {
    const tool = new SetModelResponseTool(z3.array(z3.string()));
    const toolContext = createToolContext();

    const fields = properties(tool._getDeclaration().parameters);
    const result = await tool.runAsync({
      args: {response: ['apple']},
      toolContext,
    });

    expect(fields['response'].type).toBe(Type.ARRAY);
    expect(result).toEqual(['apple']);
  });

  it('wraps a Zod v3 list of objects under items and validates it', async () => {
    const tool = new SetModelResponseTool(
      z3.array(z3.object({id: z3.number()})),
    );
    const toolContext = createToolContext();

    const fields = properties(tool._getDeclaration().parameters);
    const result = await tool.runAsync({args: {items: [{id: 1}]}, toolContext});

    expect(fields['items'].type).toBe(Type.ARRAY);
    expect(result).toEqual([{id: 1}]);
  });

  it('defaults an omitted items parameter to an empty list', async () => {
    const tool = new SetModelResponseTool(z.array(z.object({id: z.number()})));
    const toolContext = createToolContext();

    const result = await tool.runAsync({args: {}, toolContext});

    expect(result).toEqual([]);
    expect(toolContext.actions.setModelResponse).toEqual([]);
  });

  it('wraps a non-object genai Schema under response', async () => {
    const arraySchema: Schema = {type: Type.ARRAY, items: {type: Type.STRING}};
    const tool = new SetModelResponseTool(arraySchema);
    const toolContext = createToolContext();

    const parameters = tool._getDeclaration().parameters;
    const result = await tool.runAsync({
      args: {response: ['apple']},
      toolContext,
    });

    expect(parameters).toEqual({
      type: Type.OBJECT,
      properties: {response: arraySchema},
      required: ['response'],
    });
    expect(result).toEqual(['apple']);
  });
});
