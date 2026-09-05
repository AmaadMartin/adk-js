/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/agents/llm/task/test_finish_task_tool.py` @ `main`. Each
 * `it(...)` keeps its Python test name so the two suites stay greppable.
 */

import {
  Context,
  createSession,
  FINISH_TASK_INSTRUCTION,
  FINISH_TASK_TOOL_NAME,
  FinishTaskAgent,
  FinishTaskTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  SchemaLike,
} from '@google/adk';
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

/** The adk-js analogue of Python's `_make_task_agent`. */
function makeTaskAgent(
  outputSchema?: SchemaLike,
  name = 'test_agent',
): FinishTaskAgent {
  return {name, outputSchema, outputSchemaSource: outputSchema};
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
    const tool = FinishTaskTool.forAgent(makeTaskAgent());

    expect(tool.name).toEqual(FINISH_TASK_TOOL_NAME);
    expect(tool.description).toContain('Signal that this agent has completed');
    expect(tool.description).not.toContain('output data');
  });

  it('test_init_with_output_schema', () => {
    const tool = FinishTaskTool.forAgent(makeTaskAgent(SampleOutputSchema));

    expect(tool.name).toEqual(FINISH_TASK_TOOL_NAME);
    expect(tool.outputSchema).toBe(SampleOutputSchema);
    expect(tool.description).toContain('Signal that this agent has completed');
    expect(tool.description).toContain('output data');
  });

  it('test_get_declaration_without_output_schema', () => {
    const tool = FinishTaskTool.forAgent(makeTaskAgent());

    expect(declaredProperties(tool)).toHaveProperty('result');
  });

  it('test_get_declaration_with_output_schema', () => {
    const tool = FinishTaskTool.forAgent(makeTaskAgent(SampleOutputSchema));

    const properties = declaredProperties(tool);
    expect(properties).toHaveProperty('result');
    expect(properties).toHaveProperty('count');
  });

  it('test_run_async_returns_confirmation', async () => {
    const tool = FinishTaskTool.forAgent(makeTaskAgent());

    const result = await tool.runAsync({
      args: {result: 'done'},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual('Task completed.');
  });

  it('test_run_async_with_args', async () => {
    const tool = FinishTaskTool.forAgent(makeTaskAgent(SampleOutputSchema));

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
    const tool = FinishTaskTool.forAgent(makeTaskAgent());
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
    const tool = FinishTaskTool.forAgent(makeTaskAgent(SampleOutputSchema));

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
    const tool = FinishTaskTool.forAgent(makeTaskAgent(SampleOutputSchema));

    const result = await tool.runAsync({
      args: {result: 'success', count: 'not_an_int'},
      toolContext: makeToolContext(),
    });

    const {error} = result as {error: string};
    expect(error).toContain('validation errors');
    expect(error).toContain('count');
  });

  it('test_run_async_validation_passes_with_valid_args', async () => {
    const tool = FinishTaskTool.forAgent(makeTaskAgent(SampleOutputSchema));

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
      const tool = FinishTaskTool.forAgent(makeTaskAgent(outputSchema));

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
      const tool = FinishTaskTool.forAgent(makeTaskAgent(outputSchema));

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
      const tool = FinishTaskTool.forAgent(makeTaskAgent(outputSchema));

      const result = await tool.runAsync({
        args,
        toolContext: makeToolContext(),
      });

      expect(result).toEqual('Task completed.');
    },
  );

  it('test_get_declaration_list_basemodel_defs_at_root', () => {
    const tool = FinishTaskTool.forAgent(
      makeTaskAgent(z.array(RegisteredSampleOutputSchema)),
    );

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
    const tool = FinishTaskTool.forAgent(makeTaskAgent(NestedOutputSchema));

    const result = await tool.runAsync({
      args: {name: 'report', details: 'not_an_object'},
      toolContext: makeToolContext(),
    });

    const {error} = result as {error: string};
    expect(error).toContain('validation errors');
    expect(error).toContain('details');
  });

  it('accepts a well-formed nested object', async () => {
    const tool = FinishTaskTool.forAgent(makeTaskAgent(NestedOutputSchema));

    const result = await tool.runAsync({
      args: {name: 'report', details: {pages: 3}},
      toolContext: makeToolContext(),
    });

    expect(result).toEqual('Task completed.');
  });
});
