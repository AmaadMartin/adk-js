/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parity tests ported from `google/adk-python`
 * `tests/unittests/workflow/test_function_node.py` @ `main` `25f5214c`.
 *
 * Each `it(...)` keeps the verbatim Python test name so a reviewer can grep for
 * it. One substitution runs through the whole file: Python reads a handler's
 * parameters off its signature, which TypeScript erases, so every ported test
 * declares them with a `parameters` object schema instead. Where Pydantic and
 * Zod genuinely differ (Pydantic coerces `'42'` to `42`, Zod does not), the
 * test asserts what adk-js does and says so.
 */

import {
  BaseNode,
  createEvent,
  Event,
  FunctionNode,
  node,
  NodeContext,
  NodeTool,
  RequestInput,
  Workflow,
} from '@google/adk';
import {Blob, Content, Type} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod/v4';
import {AuthCredentialTypes} from '../../src/auth/auth_credential.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {logger} from '../../src/utils/logger.js';
import {toJsonSchema} from '../../src/utils/schema.js';
import {createIc, driveWorkflow} from './test_helpers.js';

const apiKeyConfig = (): AuthConfig => ({
  credentialKey: 'test_key',
  authScheme: {type: 'apiKey', name: 'X-Api-Key', in: 'header'},
  rawAuthCredential: {authType: AuthCredentialTypes.API_KEY},
});

/** Runs `nodes` as a single chain from START and returns the run result. */
function runChain(
  name: string,
  nodes: BaseNode[],
  input?: unknown,
  ic = createIc(),
) {
  const wf = new Workflow({name, edges: [['START', ...nodes]]});
  return driveWorkflow(wf, input, {ic});
}

describe('FunctionNode parameter binding from state', () => {
  it('test_function_node_state_injection', async () => {
    const setState = new FunctionNode('set_state_node_fn', () =>
      createEvent({actions: {stateDelta: {param1: 'value1'}}}),
    );
    const check = new FunctionNode(
      'check_state_node_fn',
      (_ctx, {param1, param2}: {param1: string; param2: string}) =>
        `param1=${param1}, param2=${param2}`,
      {
        parameters: z.object({
          param1: z.string(),
          param2: z.string().default('default2'),
        }),
      },
    );

    const {output} = await runChain('state_injection', [setState, check]);
    expect(output).toBe('param1=value1, param2=default2');
  });

  it('test_function_node_state_injection_missing_param', async () => {
    const check = new FunctionNode(
      'check_state_node_fn',
      (_ctx, {param1}: {param1: string}) => `param1=${param1}`,
      {parameters: z.object({param1: z.string()})},
    );

    await expect(runChain('state_missing', [check])).rejects.toThrow(
      'Missing value for parameter "param1"',
    );
  });

  it('test_function_node_type_checking', async () => {
    const setState = new FunctionNode('set_state_node_fn', () =>
      createEvent({actions: {stateDelta: {p1: 'a string'}}}),
    );
    const check = new FunctionNode(
      'check_type_node_fn',
      (_ctx, {p1}: {p1: number}) => `p1=${p1}`,
      {parameters: z.object({p1: z.number()})},
    );

    await expect(runChain('type_checking', [setState, check])).rejects.toThrow(
      'Invalid value for parameter "p1" of function "check_type_node_fn"',
    );
  });

  it('test_function_node_input_injection', async () => {
    const node1 = new FunctionNode('node1_fn', () => ({
      p1: 'value1_from_node_input',
      p2: 100,
    }));
    const node2 = new FunctionNode(
      'node2_fn',
      (_ctx, {nodeInput}: {nodeInput: Record<string, unknown>}) =>
        `p1=${nodeInput['p1']}, p2=${nodeInput['p2']}`,
      {parameters: z.object({nodeInput: z.record(z.string(), z.unknown())})},
    );

    const {output} = await runChain('input_injection', [node1, node2]);
    expect(output).toBe('p1=value1_from_node_input, p2=100');
  });

  it('test_function_node_input_injection_pydantic', async () => {
    const node1 = new FunctionNode('node1_fn', () => ({
      p1: 'value1_from_node_input',
      p2: 100,
    }));
    const node2 = new FunctionNode(
      'node2_fn',
      (_ctx, {nodeInput}: {nodeInput: {p1: string; p2: number}}) =>
        `p1=${nodeInput.p1}, p2=${nodeInput.p2}`,
      {
        parameters: z.object({
          nodeInput: z.object({p1: z.string(), p2: z.number()}),
        }),
      },
    );

    const {output} = await runChain('input_pydantic', [node1, node2]);
    expect(output).toBe('p1=value1_from_node_input, p2=100');
  });

  it('test_function_node_input_list_wrong_type', async () => {
    const node1 = new FunctionNode('node1_fn', () => 123);
    const node2 = new FunctionNode(
      'node2_fn',
      (_ctx, {nodeInput}: {nodeInput: Array<{p1: string}>}) =>
        `p1=${nodeInput[0].p1}`,
      {
        parameters: z.object({
          nodeInput: z.array(z.object({p1: z.string()})),
        }),
      },
    );

    // Python rejects this while binding. adk-js infers `inputSchema` from the
    // declared `nodeInput` parameter, so `BaseNode.validateInput` rejects it one
    // layer earlier; Python's own assertion is just "it raises".
    await expect(runChain('list_wrong_type', [node1, node2])).rejects.toThrow(
      "Node 'node2_fn' input does not match its inputSchema",
    );
  });

  it('test_function_node_input_list_no_item_type', async () => {
    const node1 = new FunctionNode('node1_fn', () => [1, 2]);
    const node2 = new FunctionNode(
      'node2_fn',
      (_ctx, {nodeInput}: {nodeInput: unknown[]}) =>
        `list=${JSON.stringify(nodeInput)}`,
      {parameters: z.object({nodeInput: z.array(z.unknown())})},
    );

    const {output} = await runChain('list_no_item_type', [node1, node2]);
    expect(output).toBe('list=[1,2]');
  });

  it('test_function_node_input_and_state_injection', async () => {
    const nodeA = new FunctionNode('nodea_fn', function* () {
      yield createEvent({actions: {stateDelta: {p_state: 'value_from_state'}}});
      yield 'value_A';
    });
    const nodeB = new FunctionNode(
      'nodeb_fn',
      (
        _ctx,
        {
          nodeInput,
          p_state: pState,
          p_default: pDefault,
        }: {nodeInput: string; p_state: string; p_default: string},
      ) => `node_input=${nodeInput}, p_state=${pState}, p_default=${pDefault}`,
      {
        parameters: z.object({
          nodeInput: z.string(),
          p_state: z.string(),
          p_default: z.string().default('default2'),
        }),
      },
    );

    const {output} = await runChain('input_and_state', [nodeA, nodeB]);
    expect(output).toBe(
      'node_input=value_A, p_state=value_from_state, p_default=default2',
    );
  });

  it('test_function_node_state_injection_pydantic', async () => {
    const node1 = new FunctionNode('node1_fn', () =>
      createEvent({
        actions: {
          stateDelta: {my_model: {p1: 'value1_from_state', p2: 200}},
        },
      }),
    );
    const node2 = new FunctionNode(
      'node2_fn',
      (_ctx, {my_model: myModel}: {my_model: {p1: string; p2: number}}) =>
        `p1=${myModel.p1}, p2=${myModel.p2}`,
      {
        parameters: z.object({
          my_model: z.object({p1: z.string(), p2: z.number()}),
        }),
      },
    );

    const {output} = await runChain('state_pydantic', [node1, node2]);
    expect(output).toBe('p1=value1_from_state, p2=200');
  });

  it('test_function_node_list_conversion_pydantic', async () => {
    const section = z.object({section_name: z.string(), content: z.string()});
    let received: unknown;
    const upstream = new FunctionNode('upstream_func', () => [
      {section_name: 's1', content: 'c1'},
      {section_name: 's2', content: 'c2'},
    ]);
    const aggregate = new FunctionNode(
      'aggregate',
      (_ctx, {nodeInput}: {nodeInput: unknown}) => {
        received = nodeInput;
        return 'Done';
      },
      {parameters: z.object({nodeInput: z.array(section)})},
    );

    const {output} = await runChain('list_conversion', [upstream, aggregate]);
    expect(output).toBe('Done');
    expect(received).toEqual([
      {section_name: 's1', content: 'c1'},
      {section_name: 's2', content: 'c2'},
    ]);
  });

  it('test_function_node_dict_conversion_pydantic', async () => {
    const section = z.object({section_name: z.string(), content: z.string()});
    let received: unknown;
    const upstream = new FunctionNode('upstream_func', () => ({
      one: {section_name: 's1', content: 'c1'},
      two: {section_name: 's2', content: 'c2'},
    }));
    const aggregate = new FunctionNode(
      'aggregate',
      (_ctx, {nodeInput}: {nodeInput: unknown}) => {
        received = nodeInput;
        return 'Done';
      },
      {parameters: z.object({nodeInput: z.record(z.string(), section)})},
    );

    const {output} = await runChain('dict_conversion', [upstream, aggregate]);
    expect(output).toBe('Done');
    expect(received).toEqual({
      one: {section_name: 's1', content: 'c1'},
      two: {section_name: 's2', content: 'c2'},
    });
  });
});

describe('FunctionNode Content to string conversion', () => {
  /** A node whose single declared string parameter is the raw node input. */
  function recorder(received: string[], parameter: z.ZodType = z.string()) {
    return new FunctionNode(
      'record_input',
      (_ctx, {nodeInput}: {nodeInput: string}) => {
        received.push(nodeInput);
        return `Hello, ${nodeInput}!`;
      },
      {parameters: z.object({nodeInput: parameter})},
    );
  }

  const userContent = (content: Content): Content => content;

  it('test_content_to_str_auto_conversion', async () => {
    const received: string[] = [];
    await runChain(
      'content_to_str',
      [recorder(received)],
      userContent({role: 'user', parts: [{text: 'start workflow'}]}),
    );
    expect(received).toEqual(['start workflow']);
  });

  it('test_content_to_str_multi_part', async () => {
    const received: string[] = [];
    await runChain(
      'content_to_str_multi_part',
      [recorder(received)],
      userContent({role: 'user', parts: [{text: 'Hello '}, {text: 'World'}]}),
    );
    expect(received).toEqual(['Hello World']);
  });

  it('test_content_to_str_warns_on_non_text', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const received: string[] = [];
    const inlineData: Blob = {data: 'aW1n', mimeType: 'image/png'};

    await runChain(
      'content_to_str_warns',
      [recorder(received)],
      userContent({role: 'user', parts: [{text: 'Hello'}, {inlineData}]}),
    );

    expect(received).toEqual(['Hello']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('non-text parts'),
    );
    warn.mockRestore();
  });

  it('test_optional_str_with_content_auto_conversion', async () => {
    const received: string[] = [];
    await runChain(
      'optional_content',
      [recorder(received, z.string().optional())],
      userContent({role: 'user', parts: [{text: 'hello'}]}),
    );
    expect(received).toEqual(['hello']);
  });
});

describe('FunctionNode union parameter types', () => {
  const unionParameters = z.object({
    nodeInput: z.union([
      z.array(z.unknown()),
      z.record(z.string(), z.unknown()),
    ]),
  });

  it('test_union_type_accepts_matching_member', async () => {
    for (const value of [[1, 2, 3], {key: 'value'}]) {
      const received: unknown[] = [];
      const produce = new FunctionNode('produce_value', () => value);
      const record = new FunctionNode(
        'record_input',
        (_ctx, {nodeInput}: {nodeInput: unknown}) => {
          received.push(nodeInput);
          return 'ok';
        },
        {parameters: unionParameters},
      );

      const {output} = await runChain('union_accept', [produce, record]);
      expect(output).toBe('ok');
      expect(received).toEqual([value]);
    }
  });

  it('test_union_type_rejects_non_matching', async () => {
    const produce = new FunctionNode('produce_number', () => 123);
    const bad = new FunctionNode('bad_input', () => 'should not reach', {
      parameters: unionParameters,
    });

    // Rejected by the inferred `inputSchema`, one layer above binding.
    await expect(runChain('union_reject', [produce, bad])).rejects.toThrow(
      "Node 'bad_input' input does not match its inputSchema",
    );
  });
});

describe('FunctionNode output schema', () => {
  const outputModel = z.object({name: z.string(), value: z.number()});
  const otherModel = z.object({
    name: z.string(),
    value: z.number(),
    extra: z.string().default('default'),
  });

  it('test_output_schema_inferred_validates_dict', async () => {
    const produce = new FunctionNode(
      'produce',
      () => ({name: 'test', value: 42}),
      {outputSchema: outputModel},
    );
    const {output} = await runChain('wf', [produce]);
    expect(output).toEqual({name: 'test', value: 42});
  });

  it('test_output_schema_inferred_rejects_invalid', async () => {
    const produce = new FunctionNode('produce', () => ({name: 'test'}), {
      outputSchema: outputModel,
    });
    await expect(runChain('wf', [produce])).rejects.toThrow(/output/i);
  });

  it('test_output_schema_inferred_rejects_wrong_type', async () => {
    const produce = new FunctionNode('produce', () => 'not a dict', {
      outputSchema: outputModel,
    });
    await expect(runChain('wf', [produce])).rejects.toThrow(/output/i);
  });

  it('test_output_schema_generator_rejects_invalid_item', async () => {
    const produce = new FunctionNode(
      'produce_items',
      function* () {
        yield {name: 'a', value: 1};
        yield {name: 'bad'};
      },
      {outputSchema: outputModel},
    );
    await expect(runChain('wf', [produce])).rejects.toThrow(/output/i);
  });

  it('test_output_schema_inferred_coerces_defaults', async () => {
    const produce = new FunctionNode(
      'produce',
      () => ({name: 'test', value: 5}),
      {outputSchema: otherModel},
    );
    const {output} = await runChain('wf', [produce]);
    expect(output).toEqual({name: 'test', value: 5, extra: 'default'});
  });

  it('test_output_schema_inferred_type_coercion', async () => {
    // Pydantic coerces '42' to 42; Zod rejects it unless the schema opts in
    // with `z.coerce`. adk-js validates, it does not silently widen.
    const produce = new FunctionNode(
      'produce',
      () => ({name: 'coerce', value: '42'}),
      {outputSchema: outputModel},
    );
    await expect(runChain('wf', [produce])).rejects.toThrow(/output/i);
  });

  it('test_output_schema_none_return', async () => {
    const produceNone = new FunctionNode('produce_none', () => null, {
      outputSchema: outputModel,
    });
    const downstream = new FunctionNode(
      'downstream',
      (_ctx, input) => `got: ${input}`,
    );
    const {output} = await runChain('wf', [produceNone, downstream]);
    expect(output).toBe('got: undefined');
  });

  it('test_output_schema_validates_returned_event_data', async () => {
    const produce = new FunctionNode(
      'produce',
      () => createEvent({output: {name: 'evt', value: 7}}),
      {outputSchema: outputModel},
    );
    const {output} = await runChain('wf', [produce]);
    expect(output).toEqual({name: 'evt', value: 7});
  });

  it('test_output_schema_rejects_invalid_returned_event_data', async () => {
    const produce = new FunctionNode(
      'produce',
      () => createEvent({output: {wrong_field: 'oops'}}),
      {outputSchema: outputModel},
    );
    await expect(runChain('wf', [produce])).rejects.toThrow(/output/i);
  });
});

describe('FunctionNode input schema', () => {
  const outputModel = z.object({name: z.string(), value: z.number()});
  const otherModel = z.object({
    name: z.string(),
    value: z.number(),
    extra: z.string().default('default'),
  });

  /** Records what the node received after `inputSchema` validation. */
  function processor(received: unknown[], inputSchema: z.ZodType) {
    return new FunctionNode(
      'process',
      (_ctx, input) => {
        received.push(input);
        return 'ok';
      },
      {inputSchema},
    );
  }

  it('test_input_schema_validates_dict', async () => {
    const received: unknown[] = [];
    const produce = new FunctionNode('produce', () => ({
      name: 'test',
      value: 42,
    }));
    await runChain('wf', [produce, processor(received, outputModel)]);
    expect(received).toEqual([{name: 'test', value: 42}]);
  });

  it('test_input_schema_rejects_invalid_dict', async () => {
    const produce = new FunctionNode('produce', () => ({name: 'test'}));
    await expect(
      runChain('wf', [produce, processor([], outputModel)]),
    ).rejects.toThrow(/input/i);
  });

  it('test_input_schema_coerces_types', async () => {
    // Pydantic coerces '5' to 5; Zod rejects it. adk-js rejects.
    const produce = new FunctionNode('produce', () => ({
      name: 'test',
      value: '5',
    }));
    await expect(
      runChain('wf', [produce, processor([], outputModel)]),
    ).rejects.toThrow(/input/i);
  });

  it('test_input_schema_fills_defaults', async () => {
    const received: unknown[] = [];
    const produce = new FunctionNode('produce', () => ({
      name: 'test',
      value: 1,
    }));
    await runChain('wf', [produce, processor(received, otherModel)]);
    expect(received).toEqual([{name: 'test', value: 1, extra: 'default'}]);
  });

  it('test_input_schema_none_passthrough', async () => {
    // Divergence, asserted as adk-js behaves today: Python skips input
    // validation for a `None` input, `BaseNode.validateInput` does not skip an
    // `undefined` one. That gate is shared by every node type, so changing it
    // is out of scope here.
    const produceNone = new FunctionNode('produce_none', () => null);
    const process = new FunctionNode(
      'process',
      (_ctx, input) => `got: ${input}`,
      {inputSchema: outputModel},
    );
    await expect(runChain('wf', [produceNone, process])).rejects.toThrow(
      "Node 'process' input does not match its inputSchema",
    );
  });
});

describe('TestAuthConfig', () => {
  it('test_raises_without_rerun_on_resume', () => {
    expect(
      () => new FunctionNode('n', () => null, {authConfig: apiKeyConfig()}),
    ).toThrow('rerunOnResume');
  });

  it('test_no_auth_config_default', () => {
    expect(new FunctionNode('n', () => null).authConfig).toBeUndefined();
  });

  it('test_rerun_on_resume_explicit_true_with_auth', () => {
    const built = new FunctionNode('n', () => null, {
      authConfig: apiKeyConfig(),
      rerunOnResume: true,
    });
    expect(built.rerunOnResume).toBe(true);
    expect(built.authConfig).toBeDefined();
  });
});

describe('TestParameterBindingNodeInput', () => {
  const addParameters = z.object({x: z.number(), y: z.number()});
  const addDefaultedParameters = z.object({
    x: z.number(),
    y: z.number().default(10),
  });

  it('test_schemas_inferred_from_signature', () => {
    const add = new FunctionNode(
      'add',
      (_ctx, {x, y}: {x: number; y: number}) => x + y,
      {parameterBinding: 'nodeInput', parameters: addParameters},
    );

    expect(add.parameterBinding).toBe('nodeInput');
    expect(add.inputSchema).toBe(addParameters);
    const document = toJsonSchema(add.inputSchema!);
    expect(Object.keys(document['properties'] as object)).toEqual(['x', 'y']);
    // outputSchema has no TypeScript counterpart: there is no runtime return
    // type to read, so it stays explicit.
    expect(add.outputSchema).toBeUndefined();
  });

  it('test_ctx_param_excluded_from_schema', () => {
    const greet = new FunctionNode(
      'greet',
      (_ctx, {name}: {name: string}) => `Hello, ${name}!`,
      {parameterBinding: 'nodeInput', parameters: z.object({name: z.string()})},
    );

    // `ctx` is the fixed first argument in TypeScript, never a declared
    // parameter, so it cannot reach the schema in the first place.
    const document = toJsonSchema(greet.inputSchema!);
    expect(Object.keys(document['properties'] as object)).toEqual(['name']);
  });

  it('test_bind_from_node_input', async () => {
    for (const [producerOutput, expected] of [
      [{x: 5, y: 2}, 7],
      [{x: 5}, 15],
    ] as const) {
      const produce = new FunctionNode('produce', () => producerOutput);
      const add = new FunctionNode(
        'add',
        (_ctx, {x, y}: {x: number; y: number}) => x + y,
        {parameterBinding: 'nodeInput', parameters: addDefaultedParameters},
      );

      const {output} = await runChain('bind_from_node_input', [produce, add]);
      expect(output).toBe(expected);
    }
  });

  it('test_bind_from_node_input_missing_required', async () => {
    const produce = new FunctionNode('produce', () => ({x: 5}));
    const add = new FunctionNode(
      'add',
      (_ctx, {x, y}: {x: number; y: number}) => x + y,
      {parameterBinding: 'nodeInput', parameters: addParameters},
    );

    // The schema inferred from `parameters` rejects the incomplete input before
    // binding runs, so this reports the missing `y` as a schema failure.
    await expect(
      runChain('bind_node_input_missing', [produce, add]),
    ).rejects.toThrow(
      /Node 'add' input does not match its inputSchema[\s\S]*"y"/,
    );

    // With an explicit, looser `inputSchema` the gate passes and binding
    // reports the missing parameter itself, in Python's wording.
    const lenient = new FunctionNode(
      'add',
      (_ctx, {x, y}: {x: number; y: number}) => x + y,
      {
        parameterBinding: 'nodeInput',
        parameters: addParameters,
        inputSchema: z.record(z.string(), z.unknown()),
      },
    );
    await expect(
      runChain('bind_node_input_missing_lenient', [produce, lenient]),
    ).rejects.toThrow(
      'Missing value for parameter "y" of function "add". It was not found in ' +
        'nodeInput and has no default value.',
    );
  });

  it('test_bind_from_node_input_with_ctx', async () => {
    const receivedCtx: NodeContext[] = [];
    const produce = new FunctionNode('produce', () => ({name: 'Alice'}));
    const greet = new FunctionNode(
      'greet',
      (ctx, {name}: {name: string}) => {
        receivedCtx.push(ctx);
        return `Hello, ${name}!`;
      },
      {parameterBinding: 'nodeInput', parameters: z.object({name: z.string()})},
    );

    const {output} = await runChain('bind_node_input_ctx', [produce, greet]);
    expect(output).toBe('Hello, Alice!');
    expect(receivedCtx).toHaveLength(1);
    expect(receivedCtx[0].state).toBeDefined();
  });

  it('test_model_copy_preserves_parameter_binding', async () => {
    const add = new FunctionNode(
      'add',
      (_ctx, {x, y}: {x: number; y: number}) => x + y,
      {parameterBinding: 'nodeInput', parameters: addDefaultedParameters},
    );
    const copied = node(add, {name: 'add_copy'}) as FunctionNode;

    expect(copied.name).toBe('add_copy');
    expect(copied.parameterBinding).toBe('nodeInput');
    expect(copied.inputSchema).toBe(add.inputSchema);

    // The compiled descriptors survive the copy, so the clone still binds.
    const produce = new FunctionNode('produce', () => ({x: 1}));
    const {output} = await runChain('copy_binds', [produce, copied]);
    expect(output).toBe(11);
  });

  it('exposes a nodeInput-bound node as a NodeTool without an explicit schema', () => {
    const add = new FunctionNode(
      'add',
      (_ctx, {x, y}: {x: number; y: number}) => x + y,
      {parameterBinding: 'nodeInput', parameters: addParameters},
    );

    // `NodeTool` refuses a node with no inputSchema; the inference is what
    // makes this work.
    const tool = new NodeTool(add);
    const declaration = tool._getDeclaration();
    expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
      'x',
      'y',
    ]);
    expect(declaration.parameters?.type).toBe(Type.OBJECT);
  });
});

describe('FunctionNode event handling', () => {
  it('test_function_node_hitl', async () => {
    const requestInput = new FunctionNode('request_input_fn', function* (ctx) {
      const answer = ctx.resumeInputs['ask-1'];
      if (answer === undefined) {
        yield new RequestInput({
          interruptId: 'ask-1',
          message: 'Provide input',
        });
        return;
      }
      yield answer;
    });
    const process = new FunctionNode(
      'process_input_fn',
      (_ctx, {nodeInput}: {nodeInput: {text: string}}) =>
        `received: ${nodeInput.text}`,
      {parameters: z.object({nodeInput: z.object({text: z.string()})})},
    );
    const wf = new Workflow({
      name: 'hitl',
      edges: [['START', requestInput, process]],
    });

    const paused = await driveWorkflow(wf);
    expect(paused.interruptIds).toEqual(['ask-1']);

    const resumed = await driveWorkflow(wf, undefined, {
      resumeInputs: {'ask-1': {text: 'Hello from user'}},
    });
    expect(resumed.output).toBe('received: Hello from user');
  });

  it('test_function_node_adk_events', async () => {
    const emit = new FunctionNode('adk_events_fn', function* () {
      yield createEvent({
        author: 'some_agent',
        content: {role: 'model', parts: [{text: 'event 1'}]},
      });
      yield createEvent({
        author: 'some_agent',
        content: {role: 'model', parts: [{text: 'event 2'}]},
      });
    });

    const {events} = await runChain('adk_events', [emit]);
    const texts = events.map((e: Event) => e.content?.parts?.[0]?.text);
    expect(texts).toEqual(['event 1', 'event 2']);
  });

  it('test_function_node_no_data_returns_none', async () => {
    const routeOnly = new FunctionNode('func_no_data', () =>
      createEvent({route: 'some_route'}),
    );

    const {events} = await runChain('no_data', [routeOnly]);
    expect(events).toHaveLength(1);
    expect(events[0].output).toBeUndefined();
    expect(events[0].route).toBe('some_route');
  });

  it('test_function_node_yield_content', async () => {
    const emit = new FunctionNode('yield_content_fn', function* () {
      yield {role: 'model', parts: [{text: 'hi'}]};
    });

    const {events} = await runChain('yield_content', [emit]);
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe('hi');
  });

  it('test_function_node_yield_event_with_content', async () => {
    const emit = new FunctionNode('yield_event_fn', function* () {
      yield createEvent({content: {role: 'model', parts: [{text: 'evt'}]}});
    });

    const {events} = await runChain('yield_event_content', [emit]);
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe('evt');
  });
});

describe('FunctionNode name inference', () => {
  it('infers the node name from the wrapped function', () => {
    function greet() {
      return 'hi';
    }
    expect(new FunctionNode(greet).name).toBe('greet');
  });

  it('prefers an explicit config name over the function name', () => {
    function greet() {
      return 'hi';
    }
    expect(new FunctionNode(greet, {name: 'welcome'}).name).toBe('welcome');
  });

  it('throws when neither the argument nor the function supplies a name', () => {
    expect(() => new FunctionNode((() => 'hi') as () => string)).toThrow(
      'FunctionNode must have a name',
    );
  });

  it('still accepts the explicit (name, handler, config) form', () => {
    const built = new FunctionNode('explicit', () => 'hi', {
      description: 'a node',
    });
    expect(built.name).toBe('explicit');
    expect(built.description).toBe('a node');
  });

  it('defaults description to an empty string', () => {
    expect(new FunctionNode('n', () => null).description).toBe('');
  });
});
