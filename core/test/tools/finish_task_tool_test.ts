/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python suite is ported first, each `it(...)` keeping its Python test
 * name so the two stay greppable:
 * `tests/unittests/agents/llm/task/test_finish_task_tool.py` @ `main`. The
 * blocks after it cover behaviour adk-js adds on top.
 */

import {
  Context,
  createEvent,
  createSession,
  FINISH_TASK_DEFAULT_WRAPPER_KEY,
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_INSTRUCTION,
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
  FinishTaskTool,
  getOutputWrapperKey,
  InMemorySessionService,
  InvocationContext,
  isFinishTaskTerminalResponse,
  LlmAgent,
  LlmRequest,
  PluginManager,
  SchemaLike,
} from '@google/adk';
import {Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';

const SampleOutputSchema = z.object({
  result: z.string(),
  count: z.number().int(),
});

const NestedOutputSchema = z.object({
  name: z.string(),
  details: z.record(z.string(), z.unknown()),
});

/**
 * Zod v4 inlines a subschema it uses once, so `z.array(SampleOutputSchema)`
 * emits no `$defs` at all. Registering an id makes it emit the `$defs` plus
 * `$ref` pair that pydantic produces for `list[SampleOutputSchema]`, which is
 * what the hoisting test needs.
 */
const RegisteredSampleOutputSchema = SampleOutputSchema.meta({
  id: 'SampleOutputSchema',
});

/**
 * The adk-js analogue of Python's `_make_task_agent` and the
 * `FinishTaskTool(task_agent=...)` call that consumes it.
 *
 * `LlmAgent` passes both forms of its schema: the declared one the model is
 * shown, and the one the caller supplied, which arguments are checked against.
 */
function toolForTaskAgent(outputSchema?: SchemaLike): FinishTaskTool {
  return new FinishTaskTool(outputSchema, outputSchema);
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

/**
 * A genai `Schema` as it arrives deserialized from JSON, where `type` keeps its
 * JSON Schema casing. The `Schema` type only admits the genai `Type` enum, so
 * such a record has to be parsed rather than written as a literal.
 */
function schemaFromJson(json: string): Schema {
  return JSON.parse(json) as Schema;
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

/** The declaration's parameters, whichever field the tool rendered them into. */
function declaredProperties(tool: FinishTaskTool): Record<string, unknown> {
  const declaration = tool._getDeclaration();
  expect(declaration.name).toEqual(FINISH_TASK_TOOL_NAME);
  const document =
    declaration.parametersJsonSchema ?? declaration.parameters ?? {};
  const properties = (document as {properties?: unknown}).properties;
  return (properties ?? {}) as Record<string, unknown>;
}

describe('TestFinishTaskTool', () => {
  it('test_init_without_output_schema', () => {
    const tool = toolForTaskAgent();

    expect(tool.name).toEqual(FINISH_TASK_TOOL_NAME);
    expect(tool.description).toContain('Signal that this agent has completed');
    expect(tool.description).not.toContain('output data');
  });

  it('test_init_with_output_schema', () => {
    const tool = toolForTaskAgent(SampleOutputSchema);

    expect(tool.name).toEqual(FINISH_TASK_TOOL_NAME);
    expect(tool.outputSchema).toBe(SampleOutputSchema);
    expect(tool.description).toContain('Signal that this agent has completed');
    expect(tool.description).toContain('output data');
  });

  it('test_get_declaration_without_output_schema', () => {
    const tool = toolForTaskAgent();

    expect(declaredProperties(tool)).toHaveProperty('result');
  });

  it('test_get_declaration_with_output_schema', () => {
    const tool = toolForTaskAgent(SampleOutputSchema);

    const properties = declaredProperties(tool);
    expect(properties).toHaveProperty('result');
    expect(properties).toHaveProperty('count');
  });

  it('test_run_async_returns_confirmation', async () => {
    const tool = toolForTaskAgent();

    const result = await tool.runAsync({
      args: {result: 'done'},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual('Task completed.');
  });

  it('test_run_async_with_args', async () => {
    const tool = toolForTaskAgent(SampleOutputSchema);

    const result = await tool.runAsync({
      args: {result: 'success', count: 42},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual('Task completed.');
  });
});

describe('TestBuildInstruction', () => {
  it('test_instruction_content', () => {
    expect(FINISH_TASK_INSTRUCTION).toContain('finish_task');
    expect(FINISH_TASK_INSTRUCTION).toContain(
      'Do NOT call `finish_task` prematurely',
    );
    expect(FINISH_TASK_INSTRUCTION).toContain(
      'call `finish_task` by itself with',
    );
  });
});

describe('TestProcessLlmRequest', () => {
  it('test_process_llm_request_adds_tool_and_instruction', async () => {
    const tool = toolForTaskAgent();
    const llmRequest: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };

    await tool.processLlmRequest({toolContext: makeToolContext(), llmRequest});

    expect(llmRequest.toolsDict[FINISH_TASK_TOOL_NAME]).toBe(tool);
    expect(llmRequest.config?.systemInstruction).toEqual(
      FINISH_TASK_INSTRUCTION,
    );
  });
});

describe('TestFinishTaskToolName', () => {
  it('test_constant_value', () => {
    expect(FINISH_TASK_TOOL_NAME).toEqual('finish_task');
  });
});

describe('TestFinishTaskToolValidation', () => {
  it('test_run_async_validation_error_missing_required_field', async () => {
    const tool = toolForTaskAgent(SampleOutputSchema);

    const result = await tool.runAsync({
      args: {result: 'success'},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual({
      error: expect.stringContaining('validation errors') as string,
    });
    const {error} = result as {error: string};
    expect(error).toContain('finish_task');
    expect(error).toContain('count');
  });

  it('test_run_async_validation_error_wrong_type', async () => {
    const tool = toolForTaskAgent(SampleOutputSchema);

    const result = await tool.runAsync({
      args: {result: 'success', count: 'not_an_int'},
      toolContext: makeToolContext(),
    });

    const {error} = result as {error: string};
    expect(error).toContain('validation errors');
    expect(error).toContain('count');
  });

  it('test_run_async_validation_passes_with_valid_args', async () => {
    const tool = toolForTaskAgent(SampleOutputSchema);

    const result = await tool.runAsync({
      args: {result: 'success', count: 42},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual('Task completed.');
  });
});

describe('TestFinishTaskToolAllSchemaTypes', () => {
  const wrapperKeyCases: ReadonlyArray<
    [string, SchemaLike, string | undefined]
  > = [
    ['BaseModel', SampleOutputSchema, undefined],
    ['dict', z.record(z.string(), z.unknown()), undefined],
    ['str', z.string(), 'result'],
    ['int', z.number().int(), 'result'],
    ['bool', z.boolean(), 'result'],
    ['float', z.number(), 'result'],
    ['list_str', z.array(z.string()), 'result'],
    ['list_int', z.array(z.number().int()), 'result'],
    ['list_BaseModel', z.array(SampleOutputSchema), 'result'],
  ];

  it.each(wrapperKeyCases)(
    'test_wrapper_key[%s]',
    (_id, outputSchema, expected) => {
      const tool = toolForTaskAgent(outputSchema);

      expect(tool.wrapperKey).toEqual(expected);
    },
  );

  const wrappedDeclarationCases: ReadonlyArray<[string, SchemaLike]> = [
    ['str', z.string()],
    ['int', z.number().int()],
    ['bool', z.boolean()],
    ['float', z.number()],
    ['list_str', z.array(z.string())],
    ['list_int', z.array(z.number().int())],
    ['list_BaseModel', z.array(SampleOutputSchema)],
  ];

  it.each(wrappedDeclarationCases)(
    'test_get_declaration_wrapped_schema[%s]',
    (_id, outputSchema) => {
      const tool = toolForTaskAgent(outputSchema);

      expect(declaredProperties(tool)).toHaveProperty('result');
    },
  );

  const runAsyncCases: ReadonlyArray<
    [string, SchemaLike, Record<string, unknown>]
  > = [
    ['BaseModel', SampleOutputSchema, {result: 'done', count: 5}],
    ['dict', z.record(z.string(), z.unknown()), {key: 'value'}],
    ['str', z.string(), {result: 'hello'}],
    ['int', z.number().int(), {result: 42}],
    ['bool', z.boolean(), {result: true}],
    ['float', z.number(), {result: 3.14}],
    ['list_str', z.array(z.string()), {result: ['a', 'b', 'c']}],
    ['list_int', z.array(z.number().int()), {result: [1, 2, 3]}],
    [
      'list_BaseModel',
      z.array(SampleOutputSchema),
      {result: [{result: 'ok', count: 1}]},
    ],
    ['list_str_empty', z.array(z.string()), {result: []}],
  ];

  it.each(runAsyncCases)(
    'test_run_async[%s]',
    async (_id, outputSchema, args) => {
      const tool = toolForTaskAgent(outputSchema);

      const result = await tool.runAsync({
        args,
        toolContext: makeToolContext(),
      });

      expect(result).toEqual('Task completed.');
    },
  );

  it('test_get_declaration_list_basemodel_defs_at_root', () => {
    const tool = toolForTaskAgent(z.array(RegisteredSampleOutputSchema));

    const document = tool._getDeclaration().parametersJsonSchema as {
      $defs?: Record<string, unknown>;
      properties: {result: Record<string, unknown>};
    };

    expect(document.$defs).toHaveProperty('SampleOutputSchema');
    expect(document.properties.result).not.toHaveProperty('$defs');
    expect(document.properties.result).toEqual({
      type: 'array',
      items: {$ref: '#/$defs/SampleOutputSchema'},
    });
  });
});

describe('FinishTaskTool nested schema validation', () => {
  it('rejects a nested field of the wrong type', async () => {
    const tool = toolForTaskAgent(NestedOutputSchema);

    const result = await tool.runAsync({
      args: {name: 'report', details: 'not_an_object'},
      toolContext: makeToolContext(),
    });

    const {error} = result as {error: string};
    expect(error).toContain('validation errors');
    expect(error).toContain('details');
  });

  it('accepts a well-formed nested object', async () => {
    const tool = toolForTaskAgent(NestedOutputSchema);

    const result = await tool.runAsync({
      args: {name: 'report', details: {pages: 3}},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual('Task completed.');
  });
});

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

describe('FinishTaskTool validation schema', () => {
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

    const error = await runAndGetError(new FinishTaskTool(source, source), {
      result: 'done',
    });

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

  it('hoists $defs off a schema deserialized from JSON', () => {
    // The reachable production case: a declaration read off the wire is typed
    // `Schema` but carries JSON Schema keys the genai dialect has no field for.
    const outputSchema = schemaFromJson(
      '{"type": "array", "items": {"$ref": "#/$defs/Item"},' +
        ' "$defs": {"Item": {"type": "object", "properties": {}}}}',
    );

    const document = new FinishTaskTool(outputSchema)._getDeclaration()
      .parametersJsonSchema as Record<string, unknown>;

    expect(document['$defs']).toEqual({
      Item: {type: 'object', properties: {}},
    });
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

  it.each([
    ['false', {type: Type.BOOLEAN}, false],
    ['zero', {type: Type.INTEGER}, 0],
    ['an empty string', {type: Type.STRING}, ''],
  ] as ReadonlyArray<[string, Schema, unknown]>)(
    'accepts %s as the wrapped value',
    async (_name, outputSchema, wrapped) => {
      // Only `undefined` and `null` are absent. A falsy value is present, so
      // the presence check must not test truthiness.
      const result = await new FinishTaskTool(outputSchema).runAsync({
        args: {result: wrapped},
        toolContext: makeToolContext(),
      });

      expect(result).toEqual('Task completed.');
    },
  );

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

/** An event carrying one function response. */
function responseEvent(name: string, response?: Record<string, unknown>) {
  return createEvent({
    author: 'agent',
    content: {
      role: 'user',
      parts: [{functionResponse: {id: 'fr-1', name, response}}],
    },
  });
}

describe('isFinishTaskTerminalResponse', () => {
  it('recognises a successful completion', () => {
    const event = responseEvent(FINISH_TASK_TOOL_NAME, {
      result: FINISH_TASK_SUCCESS_RESULT,
    });

    expect(isFinishTaskTerminalResponse(event)).toBe(true);
  });

  it('recognises a reported failure', () => {
    const event = responseEvent(FINISH_TASK_TOOL_NAME, {
      result: FINISH_TASK_ERROR_RESULT,
    });

    expect(isFinishTaskTerminalResponse(event)).toBe(true);
  });

  it('rejects a validation error, so the agent can retry', () => {
    const event = responseEvent(FINISH_TASK_TOOL_NAME, {
      error: 'missing required parameters: summary',
    });

    expect(isFinishTaskTerminalResponse(event)).toBe(false);
  });

  it('rejects a response with no payload', () => {
    const event = responseEvent(FINISH_TASK_TOOL_NAME);

    expect(isFinishTaskTerminalResponse(event)).toBe(false);
  });

  it('rejects a response from another tool', () => {
    const event = responseEvent('other_tool', {
      result: FINISH_TASK_SUCCESS_RESULT,
    });

    expect(isFinishTaskTerminalResponse(event)).toBe(false);
  });

  it('rejects an event carrying no function response', () => {
    const event = createEvent({
      author: 'agent',
      content: {role: 'model', parts: [{text: 'done'}]},
    });

    expect(isFinishTaskTerminalResponse(event)).toBe(false);
  });
});
