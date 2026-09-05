/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/agents/llm/task/test_finish_task_tool.py` @ `main`. Each
 * `it(...)` keeps its Python test name so the two suites stay greppable.
 *
 * Python's `output_schema` accepts any `SchemaType`, so its cases name `str`,
 * `int` and `list[str]` directly. `LlmAgentSchema` admits only an object-typed
 * Zod schema or a genai `Schema`, so the non-object cases are written in the
 * genai dialect, which is the form a task agent actually holds.
 */

import {
  Context,
  createSession,
  FINISH_TASK_TOOL_NAME,
  FinishTaskTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmAgentSchema,
  LlmRequest,
  PluginManager,
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

/** Python's `dict[str, Any]`: an object schema that constrains no field. */
const DICT_SCHEMA: Schema = {type: Type.OBJECT};

/** Python's `list[SampleOutputSchema]`. */
const SAMPLE_LIST_SCHEMA: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {result: {type: Type.STRING}, count: {type: Type.INTEGER}},
    required: ['result', 'count'],
  },
};

const STRING_LIST_SCHEMA: Schema = {
  type: Type.ARRAY,
  items: {type: Type.STRING},
};

const INT_LIST_SCHEMA: Schema = {
  type: Type.ARRAY,
  items: {type: Type.INTEGER},
};

/**
 * The adk-js analogue of Python's `_make_task_agent`. A real agent rather than
 * a stand-in, so every ported case runs the construction path production uses.
 */
function makeTaskAgent(
  outputSchema?: LlmAgentSchema,
  name = 'test_agent',
): LlmAgent {
  return new LlmAgent({
    name,
    model: 'gemini-2.5-flash',
    mode: 'task',
    outputSchema,
  });
}

/** The `finish_task` tool of a task agent declaring `outputSchema`. */
function makeTool(outputSchema?: LlmAgentSchema): FinishTaskTool {
  return makeTaskAgent(outputSchema).finishTaskTool;
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

/** The properties the tool declares to the model. */
function declaredProperties(tool: FinishTaskTool): Record<string, unknown> {
  const declaration = tool._getDeclaration();
  expect(declaration.name).toEqual(FINISH_TASK_TOOL_NAME);
  return (declaration.parameters?.properties ?? {}) as Record<string, unknown>;
}

describe('TestFinishTaskTool', () => {
  it('test_init_without_output_schema', () => {
    const tool = makeTool();

    expect(tool.name).toEqual(FINISH_TASK_TOOL_NAME);
    expect(tool.description).toContain('Signal that this agent has completed');
    expect(tool.description).not.toContain('output data');
  });

  it('test_init_with_output_schema', () => {
    const agent = makeTaskAgent(SampleOutputSchema);

    const tool = agent.finishTaskTool;

    expect(tool.name).toEqual(FINISH_TASK_TOOL_NAME);
    expect(tool.outputSchema).toBe(agent.outputSchema);
    expect(tool.description).toContain('Signal that this agent has completed');
    expect(tool.description).toContain('output data');
  });

  it('test_get_declaration_without_output_schema', () => {
    expect(declaredProperties(makeTool())).toHaveProperty('result');
  });

  it('test_get_declaration_with_output_schema', () => {
    const properties = declaredProperties(makeTool(SampleOutputSchema));

    expect(properties).toHaveProperty('result');
    expect(properties).toHaveProperty('count');
  });

  it('test_run_async_returns_confirmation', async () => {
    const result = await makeTool().runAsync({
      args: {result: 'done'},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual('Task completed.');
  });

  it('test_run_async_with_args', async () => {
    const result = await makeTool(SampleOutputSchema).runAsync({
      args: {result: 'success', count: 42},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual('Task completed.');
  });
});

describe('TestBuildInstruction', () => {
  it('test_instruction_content', async () => {
    // Python reads `tool._build_instruction()`. The instruction is private
    // here, so the test reads what the tool appends to a request instead.
    const llmRequest: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };

    await makeTool().processLlmRequest({
      toolContext: makeToolContext(),
      llmRequest,
    });

    const instruction = String(llmRequest.config?.systemInstruction);
    expect(instruction).toContain('finish_task');
    expect(instruction).toContain('Do NOT call `finish_task` prematurely');
    expect(instruction).toContain('call `finish_task` by itself with');
  });
});

describe('TestProcessLlmRequest', () => {
  it('test_process_llm_request_adds_tool_and_instruction', async () => {
    const tool = makeTool();
    const llmRequest: LlmRequest = {
      contents: [],
      liveConnectConfig: {},
      toolsDict: {},
    };

    await tool.processLlmRequest({toolContext: makeToolContext(), llmRequest});

    expect(llmRequest.toolsDict[FINISH_TASK_TOOL_NAME]).toBe(tool);
    expect(llmRequest.config?.systemInstruction).toContain('finish_task');
  });
});

describe('TestFinishTaskToolName', () => {
  it('test_constant_value', () => {
    expect(FINISH_TASK_TOOL_NAME).toEqual('finish_task');
  });
});

describe('TestFinishTaskToolValidation', () => {
  it('test_run_async_validation_error_missing_required_field', async () => {
    const result = await makeTool(SampleOutputSchema).runAsync({
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
    const result = await makeTool(SampleOutputSchema).runAsync({
      args: {result: 'success', count: 'not_an_int'},
      toolContext: makeToolContext(),
    });

    const {error} = result as {error: string};
    expect(error).toContain('validation errors');
    expect(error).toContain('count');
  });

  it('test_run_async_validation_passes_with_valid_args', async () => {
    const result = await makeTool(SampleOutputSchema).runAsync({
      args: {result: 'success', count: 42},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual('Task completed.');
  });
});

describe('TestFinishTaskToolAllSchemaTypes', () => {
  const wrapperKeyCases: ReadonlyArray<
    [string, LlmAgentSchema, string | undefined]
  > = [
    ['BaseModel', SampleOutputSchema, undefined],
    ['dict', DICT_SCHEMA, undefined],
    ['str', {type: Type.STRING}, 'result'],
    ['int', {type: Type.INTEGER}, 'result'],
    ['bool', {type: Type.BOOLEAN}, 'result'],
    ['float', {type: Type.NUMBER}, 'result'],
    ['list_str', STRING_LIST_SCHEMA, 'result'],
    ['list_int', INT_LIST_SCHEMA, 'result'],
    ['list_BaseModel', SAMPLE_LIST_SCHEMA, 'result'],
  ];

  it.each(wrapperKeyCases)(
    'test_wrapper_key[%s]',
    (_id, outputSchema, expected) => {
      expect(makeTool(outputSchema).wrapperKey).toEqual(expected);
    },
  );

  const wrappedDeclarationCases: ReadonlyArray<[string, LlmAgentSchema]> = [
    ['str', {type: Type.STRING}],
    ['int', {type: Type.INTEGER}],
    ['bool', {type: Type.BOOLEAN}],
    ['float', {type: Type.NUMBER}],
    ['list_str', STRING_LIST_SCHEMA],
    ['list_int', INT_LIST_SCHEMA],
    ['list_BaseModel', SAMPLE_LIST_SCHEMA],
  ];

  it.each(wrappedDeclarationCases)(
    'test_get_declaration_wrapped_schema[%s]',
    (_id, outputSchema) => {
      expect(declaredProperties(makeTool(outputSchema))).toHaveProperty(
        'result',
      );
    },
  );

  const runAsyncCases: ReadonlyArray<
    [string, LlmAgentSchema, Record<string, unknown>]
  > = [
    ['BaseModel', SampleOutputSchema, {result: 'done', count: 5}],
    ['dict', DICT_SCHEMA, {key: 'value'}],
    ['str', {type: Type.STRING}, {result: 'hello'}],
    ['int', {type: Type.INTEGER}, {result: 42}],
    ['bool', {type: Type.BOOLEAN}, {result: true}],
    ['float', {type: Type.NUMBER}, {result: 3.14}],
    ['list_str', STRING_LIST_SCHEMA, {result: ['a', 'b', 'c']}],
    ['list_int', INT_LIST_SCHEMA, {result: [1, 2, 3]}],
    [
      'list_BaseModel',
      SAMPLE_LIST_SCHEMA,
      {result: [{result: 'ok', count: 1}]},
    ],
    ['list_str_empty', STRING_LIST_SCHEMA, {result: []}],
  ];

  it.each(runAsyncCases)(
    'test_run_async[%s]',
    async (_id, outputSchema, args) => {
      const result = await makeTool(outputSchema).runAsync({
        args,
        toolContext: makeToolContext(),
      });

      expect(result).toEqual('Task completed.');
    },
  );
});

describe('FinishTaskTool nested schema validation', () => {
  it('rejects a nested field of the wrong type', async () => {
    const result = await makeTool(NestedOutputSchema).runAsync({
      args: {name: 'report', details: 'not_an_object'},
      toolContext: makeToolContext(),
    });

    const {error} = result as {error: string};
    expect(error).toContain('validation errors');
    expect(error).toContain('details');
  });

  it('accepts a well-formed nested object', async () => {
    const result = await makeTool(NestedOutputSchema).runAsync({
      args: {name: 'report', details: {pages: 3}},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual('Task completed.');
  });
});
