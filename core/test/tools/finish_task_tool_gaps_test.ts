/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the four behaviours `FinishTaskTool` gained from `google/adk-python`
 * `src/google/adk/agents/llm/task/_finish_task_tool.py`: deep argument
 * validation, `$defs` hoisting, `getOutputWrapperKey`, and construction from
 * the task agent. The ported adk-python suite lives in
 * `finish_task_tool_test.ts`.
 */

import {
  Context,
  createSession,
  FINISH_TASK_DEFAULT_WRAPPER_KEY,
  FinishTaskTool,
  getOutputWrapperKey,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  SchemaLike,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

/**
 * A genai `Schema` as it arrives deserialized from JSON, where `type` keeps its
 * JSON Schema casing. The `Schema` type only admits the genai `Type` enum, so
 * such a record has to be parsed rather than written as a literal.
 */
function schemaFromJson(json: string): Schema {
  return JSON.parse(json) as Schema;
}

/** A tool context the tool can be run with; `FinishTaskTool` does not read it. */
function makeToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'}),
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager([]),
      sessionService: new InMemorySessionService(),
    }),
  });
}

/** The error text a `finish_task` call answered with, failing if it succeeded. */
async function runAndGetError(
  tool: FinishTaskTool,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await tool.runAsync({args, toolContext: makeToolContext()});
  if (typeof result !== 'object' || result === null || !('error' in result)) {
    expect.fail(`expected a validation error, got ${JSON.stringify(result)}`);
  }
  return String((result as {error: unknown}).error);
}

describe('getOutputWrapperKey', () => {
  const cases: ReadonlyArray<
    [string, SchemaLike | undefined, string | undefined]
  > = [
    ['genai object schema', {type: Type.OBJECT, properties: {}}, undefined],
    ['genai string schema', {type: Type.STRING}, 'result'],
    // The case that regresses if the type is read through `toJsonSchema`:
    // `genaiSchemaToJsonSchema` maps types through the genai `Type` enum, so
    // it drops a lowercase `'object'` and the record looks like a primitive.
    [
      'raw JSON Schema record',
      schemaFromJson(
        '{"type": "object", "properties": {"a": {"type": "string"}}}',
      ),
      undefined,
    ],
    ['zod object', z.object({result: z.string()}), undefined],
    ['zod array', z.array(z.string()), 'result'],
    ['no schema', undefined, undefined],
  ];

  it.each(cases)('reads %s', (_name, schema, expected) => {
    expect(getOutputWrapperKey(schema)).toEqual(expected);
  });

  it('names the wrapper parameter with the exported constant', () => {
    expect(getOutputWrapperKey(z.string())).toEqual(
      FINISH_TASK_DEFAULT_WRAPPER_KEY,
    );
  });

  it('wraps a schema that declares properties but no type', () => {
    // adk-python keys the decision off `type` alone, so a schema without one
    // counts as a non-object. Matching that is deliberate.
    expect(
      getOutputWrapperKey({properties: {result: {type: Type.STRING}}}),
    ).toEqual('result');
  });
});

describe('FinishTaskTool.forAgent', () => {
  it('captures the task agent name', () => {
    const tool = FinishTaskTool.forAgent({
      name: 'reporting_agent',
      outputSchema: z.object({result: z.string()}),
    });

    expect(tool.taskAgentName).toEqual('reporting_agent');
  });

  it('leaves the agent name unset for the bare constructor', () => {
    expect(new FinishTaskTool().taskAgentName).toBeUndefined();
  });

  it('validates against the supplied schema, not the converted one', async () => {
    // `zodObjectToSchema` drops a `refine` predicate, so the genai form accepts
    // an odd count. The tool must check the schema the caller wrote.
    const source = z
      .object({result: z.string(), count: z.number().int()})
      .refine((value) => value.count % 2 === 0, 'count must be even');
    const agent = new LlmAgent({
      name: 'even_agent',
      model: 'gemini-2.5-flash',
      mode: 'task',
      outputSchema: source,
    });

    const error = await runAndGetError(agent.finishTaskTool, {
      result: 'done',
      count: 3,
    });

    expect(error).toContain('count must be even');
    expect(
      await agent.finishTaskTool.runAsync({
        args: {result: 'done', count: 4},
        toolContext: makeToolContext(),
      }),
    ).toEqual('Task completed.');
  });

  it('declares an agent object schema through genai parameters', async () => {
    // The declaration still comes from the converted schema, so preferring the
    // source for validation does not change what the model is shown.
    const agent = new LlmAgent({
      name: 'object_agent',
      model: 'gemini-2.5-flash',
      mode: 'task',
      outputSchema: z.object({result: z.string(), count: z.number().int()}),
    });

    const declaration = agent.finishTaskTool._getDeclaration();

    expect(declaration.parametersJsonSchema).toBeUndefined();
    expect(declaration.parameters).toEqual({
      type: Type.OBJECT,
      properties: {
        result: {type: Type.STRING},
        count: {
          type: Type.INTEGER,
          minimum: Number.MIN_SAFE_INTEGER,
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
      required: ['result', 'count'],
    });
  });

  it('renders an error the model can act on when the predicate throws', async () => {
    const source = z.object({result: z.string()}).refine(() => {
      throw new Error('predicate exploded');
    });

    const error = await runAndGetError(
      FinishTaskTool.forAgent({name: 'throwing_agent', outputSchema: source}),
      {result: 'done'},
    );

    expect(error).toContain('predicate exploded');
    expect(error).toContain('validation errors');
  });
});

describe('FinishTaskTool declaration hoisting', () => {
  it('hoists $defs out of the wrapper property so its $ref resolves', () => {
    // Zod v4 inlines a subschema it uses once, so an id registration is what
    // makes it emit the `$defs` plus `$ref` pair this test needs.
    const item = z.object({a: z.string()}).meta({id: 'Item'});

    const document = new FinishTaskTool(z.array(item))._getDeclaration()
      .parametersJsonSchema as Record<string, unknown>;

    expect(document['$defs']).toHaveProperty('Item');
    expect(document['properties']).toEqual({
      result: {type: 'array', items: {$ref: '#/$defs/Item'}},
    });
    expect(document['required']).toEqual(['result']);
  });

  it('keeps the genai parameters form for a non-object genai schema', () => {
    const outputSchema: Schema = {type: Type.STRING};

    const declaration = new FinishTaskTool(outputSchema)._getDeclaration();

    expect(declaration.parametersJsonSchema).toBeUndefined();
    expect(declaration.parameters).toEqual({
      type: Type.OBJECT,
      properties: {result: outputSchema},
      required: ['result'],
    });
  });

  it('hoists the dialect declaration a zod document carries', () => {
    const tool = new FinishTaskTool(z.array(z.string()));

    const document = tool._getDeclaration().parametersJsonSchema as {
      $schema?: string;
      properties: {result: Record<string, unknown>};
    };

    expect(document.$schema).toEqual(
      'https://json-schema.org/draft/2020-12/schema',
    );
    expect(document.properties.result).toEqual({
      type: 'array',
      items: {type: 'string'},
    });
  });

  it('renders a zod object schema as a JSON Schema document', () => {
    const declaration = new FinishTaskTool(
      z.object({result: z.string()}),
    )._getDeclaration();

    expect(declaration.parameters).toBeUndefined();
    expect(declaration.parametersJsonSchema).toMatchObject({
      type: 'object',
      properties: {result: {type: 'string'}},
      required: ['result'],
    });
  });
});

describe('FinishTaskTool with a genai schema', () => {
  const outputSchema: Schema = {
    type: Type.OBJECT,
    properties: {result: {type: Type.STRING}, count: {type: Type.INTEGER}},
    required: ['result', 'count'],
  };

  it('declares the schema unchanged', () => {
    const declaration = new FinishTaskTool(outputSchema)._getDeclaration();

    expect(declaration.parameters).toBe(outputSchema);
    expect(declaration.description).toContain('output data');
  });

  it('accepts arguments that match the schema', async () => {
    const result = await new FinishTaskTool(outputSchema).runAsync({
      args: {result: 'done', count: 2},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual('Task completed.');
  });

  it('rejects a wrong-typed argument', async () => {
    const error = await runAndGetError(new FinishTaskTool(outputSchema), {
      result: 'done',
      count: 'two',
    });

    expect(error).toContain('count: ');
  });

  it('reports a missing required key', async () => {
    const error = await runAndGetError(new FinishTaskTool(outputSchema), {
      result: 'done',
    });

    expect(error).toContain('count: field required');
  });

  it('reports a missing wrapped value', async () => {
    const error = await runAndGetError(
      new FinishTaskTool({type: Type.STRING}),
      {},
    );

    expect(error).toContain('result: field required');
  });

  it('reports a null wrapped value', async () => {
    const error = await runAndGetError(
      new FinishTaskTool({type: Type.STRING}),
      {
        result: null,
      },
    );

    expect(error).toContain('result: field required');
  });

  it('reports every required key when the arguments are empty', async () => {
    const tool = new FinishTaskTool(outputSchema);

    const error = await runAndGetError(tool, {});

    expect(error).toContain('result: field required');
    expect(error).toContain('count: field required');
  });
});

describe('FinishTaskTool with an uncompilable schema', () => {
  // `z.fromJSONSchema` rejects a dangling `$ref`, so `parseWithSchema` passes
  // the value through unvalidated. The presence check has to hold on its own.
  const outputSchema = schemaFromJson(
    '{"type": "OBJECT", "properties": {"result": {"$ref": "#/$defs/missing"}}, "required": ["result"]}',
  );

  it('still reports a missing required key', async () => {
    const error = await runAndGetError(new FinishTaskTool(outputSchema), {});

    expect(error).toContain('result: field required');
  });

  it('accepts a present key rather than throwing', async () => {
    const result = await new FinishTaskTool(outputSchema).runAsync({
      args: {result: 'anything'},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual('Task completed.');
  });
});

describe('FinishTaskTool.extractOutput', () => {
  it('unwraps a non-object schema', () => {
    const tool = new FinishTaskTool({
      type: Type.ARRAY,
      items: {type: Type.STRING},
    });

    expect(tool.extractOutput({result: ['a']})).toEqual(['a']);
  });

  it('returns the arguments for an object schema', () => {
    const tool = new FinishTaskTool({
      type: Type.OBJECT,
      properties: {result: {type: Type.STRING}},
    });

    expect(tool.extractOutput({result: 'a'})).toEqual({result: 'a'});
  });
});
