/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference tests ported from
 * `google/adk-python tests/unittests/workflow/test_function_node.py @ main
 * 25f5214c`. Each `it(...)` carries the reference test's name verbatim, so the
 * two suites can be diffed by name.
 *
 * One blanket substitution runs through the whole file: Python reads a
 * handler's parameter names, types and defaults off the function signature,
 * which TypeScript erases at runtime, so every ported test declares them as a
 * `parameters` object schema instead. `outputSchema` is declared for the same
 * reason, where Python infers it from the return hint.
 */

import {Content} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {AuthCredentialTypes} from '../../src/auth/auth_credential.js';
import {AuthScheme} from '../../src/auth/auth_schemes.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {createEvent, Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {logger} from '../../src/utils/logger.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {
  createRequestInputResponse,
  getRequestInputInterruptIds,
  hasRequestInputFunctionCall,
} from '../../src/workflow/utils/hitl_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow} from './test_helpers.js';

/** The Pydantic `MyModel` of the reference file, as a Zod object schema. */
const MyModel = z.object({p1: z.string(), p2: z.number()});

/** The reference file's `_OutputModel`. */
const OutputModel = z.object({name: z.string(), value: z.number()});

/** The reference file's `_OtherModel`, which declares a defaulted field. */
const OtherModel = z.object({
  name: z.string(),
  value: z.number(),
  extra: z.string().default('default'),
});

/** The outputs of the events a driven workflow emitted, in order. */
function outputs(events: Event[]): unknown[] {
  return events.map((e) => e.output);
}

/** The `(author, output)` pair of every event, in order. */
function authoredOutputs(
  events: Event[],
): Array<[string | undefined, unknown]> {
  return events.map((e) => [e.author, e.output]);
}

describe('FunctionNode parity — running a wrapped function', () => {
  it('test_various_function_nodes', async () => {
    const asyncGenFunc = async function* () {
      yield createEvent({output: 'Hello from AsyncGen'});
    };
    const syncFuncOut = () => 'Hello from SyncFunc';
    const asyncFuncOut = async () => 'Hello from AsyncFunc';
    const syncFuncNoOut = () => null;
    const asyncFuncNoOut = async () => null;
    const syncGenFunc = function* () {
      yield createEvent({output: 'Hello from SyncGen'});
    };
    const asyncGenFuncRawOutput = async function* () {
      yield 'Hello from AsyncGenRawOutput';
    };
    const syncGenFuncRawOutput = function* () {
      yield 'Hello from SyncGenRawOutput';
    };

    const wf = new Workflow({
      name: 'test_workflow_agent_various_function_nodes',
      edges: [
        [
          'START',
          node(asyncGenFunc, {name: 'async_gen_func'}),
          node(syncFuncOut, {name: 'sync_func_out'}),
          node(asyncFuncOut, {name: 'async_func_out'}),
          node(syncFuncNoOut, {name: 'sync_func_no_out'}),
          node(asyncFuncNoOut, {name: 'async_func_no_out'}),
          node(syncGenFunc, {name: 'sync_gen_func'}),
          node(asyncGenFuncRawOutput, {name: 'async_gen_func_raw_output'}),
          node(syncGenFuncRawOutput, {name: 'sync_gen_func_raw_output'}),
        ],
      ],
    });

    const {events} = await driveWorkflow(wf, 'start');

    // The two no-output nodes emit nothing, exactly as in the reference.
    expect(authoredOutputs(events)).toEqual([
      ['async_gen_func', 'Hello from AsyncGen'],
      ['sync_func_out', 'Hello from SyncFunc'],
      ['async_func_out', 'Hello from AsyncFunc'],
      ['sync_gen_func', 'Hello from SyncGen'],
      ['async_gen_func_raw_output', 'Hello from AsyncGenRawOutput'],
      ['sync_gen_func_raw_output', 'Hello from SyncGenRawOutput'],
    ]);
  });

  it('test_function_node_wrapped_partial', async () => {
    const greet = (_ctx: NodeContext, {name}: {name: string}) =>
      `Hello, ${name}!`;
    const bound = greet.bind(null);
    const boundNode = new FunctionNode(bound, {
      parameters: z.object({name: z.string()}),
      parameterBinding: 'nodeInput',
    });

    // `Function.prototype.bind` prefixes the wrapped function's name, and the
    // node takes that name verbatim. Python unwraps `functools.partial` to the
    // underlying `__name__`; TypeScript exposes no such handle, so the node is
    // named 'bound greet' unless the caller names it.
    expect(boundNode.name).toBe('bound greet');

    const wf = new Workflow({
      name: 'test_workflow_partial_unwrapping',
      edges: [['START', boundNode]],
    });
    const {output} = await driveWorkflow(wf, {name: 'Alice'});

    expect(output).toBe('Hello, Alice!');
  });

  it('test_function_node_undocumented_description_is_empty', () => {
    const undocumentedFn = () => undefined;

    // Python reads the docstring with `inspect.getdoc`. A JSDoc comment is
    // erased at runtime, so a description is declared or it is empty.
    expect(new FunctionNode(undocumentedFn).description).toBe('');
    expect(
      new FunctionNode(undocumentedFn, {description: 'Some documentation.'})
        .description,
    ).toBe('Some documentation.');
  });
});

describe('FunctionNode parity — binding from state', () => {
  it('test_function_node_state_injection', async () => {
    const setStateNodeFn = function* () {
      yield createEvent({actions: {stateDelta: {param1: 'value1'}}});
    };
    const checkStateNodeFn = (
      _ctx: NodeContext,
      {param1, param2}: {param1: string; param2: string},
    ) => `param1=${param1}, param2=${param2}`;

    const wf = new Workflow({
      name: 'test_workflow_agent_state_injection',
      edges: [
        [
          'START',
          node(setStateNodeFn, {name: 'set_state_node_fn'}),
          node(checkStateNodeFn, {
            name: 'check_state_node_fn',
            parameters: z.object({
              param1: z.string(),
              param2: z.string().default('default2'),
            }),
          }),
        ],
      ],
    });

    const {output} = await driveWorkflow(wf, 'start');

    expect(output).toBe('param1=value1, param2=default2');
  });

  it('test_function_node_state_injection_missing_param', async () => {
    const checkStateNodeFn = (_ctx: NodeContext, {param1}: {param1: string}) =>
      `param1=${param1}`;

    const wf = new Workflow({
      name: 'test_workflow_agent_state_injection_missing',
      edges: [
        [
          'START',
          node(checkStateNodeFn, {
            name: 'check_state_node_fn',
            parameters: z.object({param1: z.string()}),
          }),
        ],
      ],
    });

    await expect(driveWorkflow(wf, 'start')).rejects.toThrow(
      'Missing value for parameter "param1"',
    );
  });

  it('test_function_node_type_checking', async () => {
    const setStateNodeFn = function* () {
      yield createEvent({actions: {stateDelta: {p1: 'a string'}}});
    };
    const checkTypeNodeFn = (_ctx: NodeContext, {p1}: {p1: number}) =>
      `p1=${p1}`;

    const wf = new Workflow({
      name: 'test_type_checking',
      edges: [
        [
          'START',
          node(setStateNodeFn, {name: 'set_state_node_fn'}),
          node(checkTypeNodeFn, {
            name: 'check_type_node_fn',
            parameters: z.object({p1: z.number()}),
          }),
        ],
      ],
    });

    await expect(driveWorkflow(wf, 'start')).rejects.toThrow(
      'Invalid value for parameter "p1"',
    );
  });

  it('test_function_node_state_injection_pydantic', async () => {
    const node1Fn = function* () {
      yield createEvent({
        actions: {stateDelta: {myModel: {p1: 'value1_from_state', p2: 200}}},
      });
    };
    const node2Fn = (
      _ctx: NodeContext,
      {myModel}: {myModel: z.infer<typeof MyModel>},
    ) => `p1=${myModel.p1}, p2=${myModel.p2}`;

    const wf = new Workflow({
      name: 'test_workflow_agent_state_injection_pydantic',
      edges: [
        [
          'START',
          node(node1Fn, {name: 'node1_fn'}),
          node(node2Fn, {
            name: 'node2_fn',
            parameters: z.object({myModel: MyModel}),
          }),
        ],
      ],
    });

    const {output} = await driveWorkflow(wf, 'start');

    expect(output).toBe('p1=value1_from_state, p2=200');
  });

  it('test_function_node_input_and_state_injection', async () => {
    const nodeaFn = function* (ctx: NodeContext) {
      ctx.state.set('pState', 'value_from_state');
      yield 'value_A';
    };
    const nodebFn = (
      _ctx: NodeContext,
      {
        nodeInput,
        pState,
        pDefault,
      }: {nodeInput: string; pState: string; pDefault: string},
    ) => `nodeInput=${nodeInput}, pState=${pState}, pDefault=${pDefault}`;

    const wf = new Workflow({
      name: 'test_node_param_injection_single_and_state',
      edges: [
        [
          'START',
          node(nodeaFn, {name: 'nodea_fn'}),
          node(nodebFn, {
            name: 'nodeb_fn',
            parameters: z.object({
              nodeInput: z.string(),
              pState: z.string(),
              pDefault: z.string().default('default2'),
            }),
          }),
        ],
      ],
    });

    const {events} = await driveWorkflow(wf, 'start');

    expect(outputs(events)).toEqual([
      'value_A',
      'nodeInput=value_A, pState=value_from_state, pDefault=default2',
    ]);
  });

  it('test_function_node_input_injection', async () => {
    const node1Fn = () => ({p1: 'value1_from_node_input', p2: 100});
    const node2Fn = (
      _ctx: NodeContext,
      {nodeInput}: {nodeInput: {p1: string; p2: number}},
    ) => `p1=${nodeInput.p1}, p2=${nodeInput.p2}`;

    const wf = new Workflow({
      name: 'test_workflow_agent_input_injection_dict',
      edges: [
        [
          'START',
          node(node1Fn, {name: 'node1_fn'}),
          node(node2Fn, {
            name: 'node2_fn',
            parameters: z.object({
              nodeInput: z.object({p1: z.string(), p2: z.number()}),
            }),
          }),
        ],
      ],
    });

    const {events} = await driveWorkflow(wf, 'start');

    expect(outputs(events)).toEqual([
      {p1: 'value1_from_node_input', p2: 100},
      'p1=value1_from_node_input, p2=100',
    ]);
  });

  it('test_function_node_input_injection_pydantic', async () => {
    const node1Fn = () => ({p1: 'value1_from_node_input', p2: 100});
    const node2Fn = (
      _ctx: NodeContext,
      {nodeInput}: {nodeInput: z.infer<typeof MyModel>},
    ) => `p1=${nodeInput.p1}, p2=${nodeInput.p2}`;

    const wf = new Workflow({
      name: 'test_workflow_agent_input_injection_pydantic',
      edges: [
        [
          'START',
          node(node1Fn, {name: 'node1_fn'}),
          node(node2Fn, {
            name: 'node2_fn',
            parameters: z.object({nodeInput: MyModel}),
          }),
        ],
      ],
    });

    const {events} = await driveWorkflow(wf, 'start');

    expect(outputs(events)).toEqual([
      {p1: 'value1_from_node_input', p2: 100},
      'p1=value1_from_node_input, p2=100',
    ]);
  });

  it('test_function_node_input_list_wrong_type', async () => {
    const node1Fn = () => 123;
    const node2Fn = (
      _ctx: NodeContext,
      {nodeInput}: {nodeInput: Array<z.infer<typeof MyModel>>},
    ) => `p1=${nodeInput[0].p1}`;

    const wf = new Workflow({
      name: 'test_workflow_agent_input_list_wrong_type',
      edges: [
        [
          'START',
          node(node1Fn, {name: 'node1_fn'}),
          node(node2Fn, {
            name: 'node2_fn',
            parameters: z.object({nodeInput: z.array(MyModel)}),
          }),
        ],
      ],
    });

    await expect(driveWorkflow(wf, 'start')).rejects.toThrow();
  });

  it('test_function_node_input_list_no_item_type', async () => {
    const node1Fn = () => [1, 2];
    const node2Fn = (_ctx: NodeContext, {nodeInput}: {nodeInput: unknown[]}) =>
      `list=[${nodeInput.join(', ')}]`;

    const wf = new Workflow({
      name: 'test_workflow_agent_input_list_no_item_type',
      edges: [
        [
          'START',
          node(node1Fn, {name: 'node1_fn'}),
          node(node2Fn, {
            name: 'node2_fn',
            parameters: z.object({nodeInput: z.array(z.unknown())}),
          }),
        ],
      ],
    });

    const {events} = await driveWorkflow(wf, 'start');

    expect(outputs(events)).toEqual([[1, 2], 'list=[1, 2]']);
  });

  it('test_function_node_list_conversion_pydantic', async () => {
    const Section = z.object({sectionName: z.string(), content: z.string()});
    let receivedInput: Array<z.infer<typeof Section>> | undefined;

    const upstreamFunc = async () => [
      {sectionName: 's1', content: 'c1'},
      {sectionName: 's2', content: 'c2'},
    ];
    const aggregate = async (
      _ctx: NodeContext,
      {nodeInput}: {nodeInput: Array<z.infer<typeof Section>>},
    ) => {
      receivedInput = nodeInput;
      return 'Done';
    };

    const wf = new Workflow({
      name: 'test_function_node_list_conversion_pydantic',
      edges: [
        [
          'START',
          node(upstreamFunc, {name: 'upstream_func'}),
          node(aggregate, {
            name: 'aggregate',
            parameters: z.object({nodeInput: z.array(Section)}),
          }),
        ],
      ],
    });

    await driveWorkflow(wf, 'start');

    expect(receivedInput).toEqual([
      {sectionName: 's1', content: 'c1'},
      {sectionName: 's2', content: 'c2'},
    ]);
  });

  it('test_function_node_dict_conversion_pydantic', async () => {
    const Section = z.object({sectionName: z.string(), content: z.string()});
    let receivedInput: Record<string, z.infer<typeof Section>> | undefined;

    const upstreamFunc = async () => ({
      one: {sectionName: 's1', content: 'c1'},
      two: {sectionName: 's2', content: 'c2'},
    });
    const aggregate = async (
      _ctx: NodeContext,
      {nodeInput}: {nodeInput: Record<string, z.infer<typeof Section>>},
    ) => {
      receivedInput = nodeInput;
      return 'Done';
    };

    const wf = new Workflow({
      name: 'test_function_node_dict_conversion_pydantic',
      edges: [
        [
          'START',
          node(upstreamFunc, {name: 'upstream_func'}),
          node(aggregate, {
            name: 'aggregate',
            parameters: z.object({nodeInput: z.record(z.string(), Section)}),
          }),
        ],
      ],
    });

    await driveWorkflow(wf, 'start');

    expect(receivedInput).toEqual({
      one: {sectionName: 's1', content: 'c1'},
      two: {sectionName: 's2', content: 'c2'},
    });
  });
});

describe('FunctionNode parity — Content to string conversion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Builds a workflow whose only node records the string it is handed. */
  function recordingWorkflow(received: string[]): Workflow {
    const recordInput = (
      _ctx: NodeContext,
      {nodeInput}: {nodeInput: string},
    ) => {
      received.push(nodeInput);
      return `Hello, ${nodeInput}!`;
    };
    return new Workflow({
      name: 'test_content_to_str',
      edges: [
        [
          'START',
          node(recordInput, {
            name: 'record_input',
            parameters: z.object({nodeInput: z.string()}),
          }),
        ],
      ],
    });
  }

  it('test_content_to_str_auto_conversion', async () => {
    const received: string[] = [];
    const userContent: Content = {
      role: 'user',
      parts: [{text: 'start workflow'}],
    };

    await driveWorkflow(recordingWorkflow(received), userContent);

    expect(received).toEqual(['start workflow']);
  });

  it('test_content_to_str_multi_part', async () => {
    const received: string[] = [];
    const userContent: Content = {
      role: 'user',
      parts: [{text: 'Hello '}, {text: 'World'}],
    };

    await driveWorkflow(recordingWorkflow(received), userContent);

    expect(received).toEqual(['Hello World']);
  });

  it('test_content_to_str_warns_on_non_text', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const received: string[] = [];
    const userContent: Content = {
      role: 'user',
      parts: [
        {text: 'Hello'},
        {inlineData: {data: 'aW1n', mimeType: 'image/png'}},
      ],
    };

    await driveWorkflow(recordingWorkflow(received), userContent);

    expect(received).toEqual(['Hello']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('non-text parts');
  });

  it('test_optional_str_with_content_auto_conversion', async () => {
    const received: Array<string | undefined> = [];
    const recordInput = (
      _ctx: NodeContext,
      {nodeInput}: {nodeInput?: string},
    ) => {
      received.push(nodeInput);
      return 'ok';
    };
    const wf = new Workflow({
      name: 'test_optional_content',
      edges: [
        [
          'START',
          node(recordInput, {
            name: 'record_input',
            parameters: z.object({nodeInput: z.string().optional()}),
          }),
        ],
      ],
    });

    await driveWorkflow(wf, {role: 'user', parts: [{text: 'hello'}]});

    expect(received).toEqual(['hello']);
  });
});

describe('FunctionNode parity — union parameters', () => {
  const listOrRecord = z.object({
    nodeInput: z.union([
      z.array(z.unknown()),
      z.record(z.string(), z.unknown()),
    ]),
  });

  it.each([
    {id: 'list', produced: [1, 2, 3] as unknown},
    {id: 'dict', produced: {key: 'value'} as unknown},
  ])('test_union_type_accepts_matching_member ($id)', async ({produced}) => {
    const received: unknown[] = [];
    const recordInput = (
      _ctx: NodeContext,
      {nodeInput}: {nodeInput: unknown},
    ) => {
      received.push(nodeInput);
      return 'ok';
    };
    const wf = new Workflow({
      name: 'test_union_accept',
      edges: [
        [
          'START',
          node(() => produced, {name: 'produce_value'}),
          node(recordInput, {
            name: 'record_input',
            parameters: listOrRecord,
          }),
        ],
      ],
    });

    await driveWorkflow(wf, 'go');

    expect(received).toEqual([produced]);
  });

  it('test_union_type_rejects_non_matching', async () => {
    const badInput = (_ctx: NodeContext, {nodeInput}: {nodeInput: unknown}) =>
      `should not reach ${String(nodeInput)}`;
    const wf = new Workflow({
      name: 'test_union_reject',
      edges: [
        [
          'START',
          node(() => [1, 2, 3], {name: 'produce_list'}),
          node(badInput, {
            name: 'bad_input',
            parameters: z.object({
              nodeInput: z.union([z.string(), z.number()]),
            }),
          }),
        ],
      ],
    });

    await expect(driveWorkflow(wf, 'go')).rejects.toThrow();
  });
});

describe('FunctionNode parity — emitted events', () => {
  it('test_function_node_adk_events', async () => {
    const adkEventsFn = function* () {
      yield createEvent({
        author: 'some_agent',
        content: {role: 'model', parts: [{text: 'event 1'}]},
      });
      yield createEvent({
        author: 'some_agent',
        content: {role: 'model', parts: [{text: 'event 2'}]},
      });
    };
    const wf = new Workflow({
      name: 'test_workflow_agent_adk_events',
      edges: [['START', node(adkEventsFn, {name: 'adk_events_fn'})]],
    });

    const {events} = await driveWorkflow(wf, 'start');

    expect(events).toHaveLength(2);
    expect(events[0].content?.parts?.[0]?.text).toBe('event 1');
    expect(events[1].content?.parts?.[0]?.text).toBe('event 2');
  });

  it('test_function_node_no_data_returns_none', async () => {
    const funcNoData = () => createEvent({route: 'some_route'});
    const wf = new Workflow({
      name: 'test_function_node_no_data_returns_none',
      edges: [['START', node(funcNoData, {name: 'func_no_data'})]],
    });

    const {events} = await driveWorkflow(wf, 'start');

    expect(events).toHaveLength(1);
    expect(events[0].output).toBeUndefined();
    expect(events[0].route).toBe('some_route');
  });

  it('test_function_node_yield_content', async () => {
    const funcYieldContent = function* () {
      yield {role: 'model', parts: [{text: 'some content'}]};
    };
    const wf = new Workflow({
      name: 'test_function_node_yield_content',
      edges: [['START', node(funcYieldContent, {name: 'func_yield_content'})]],
    });

    const {events} = await driveWorkflow(wf, 'start');

    expect(events).toHaveLength(1);
    expect(events[0].output).toBeUndefined();
    expect(events[0].content?.parts?.[0]?.text).toBe('some content');
  });

  it('test_function_node_yield_event_with_content', async () => {
    const funcYieldEventWithContent = function* () {
      yield createEvent({
        content: {role: 'model', parts: [{text: 'some content'}]},
      });
    };
    const wf = new Workflow({
      name: 'test_function_node_yield_event_with_content',
      edges: [
        ['START', node(funcYieldEventWithContent, {name: 'func_yield_event'})],
      ],
    });

    const {events} = await driveWorkflow(wf, 'start');

    expect(events).toHaveLength(1);
    expect(events[0].output).toBeUndefined();
    expect(events[0].content?.parts?.[0]?.text).toBe('some content');
  });

  it('test_function_node_hitl', async () => {
    const requestInputFn = function* () {
      yield new RequestInput({message: 'Provide input'});
    };
    const processInputFn = (
      _ctx: NodeContext,
      {nodeInput}: {nodeInput: {text: string}},
    ) => `received: ${nodeInput.text}`;
    const wf = new Workflow({
      name: 'test_workflow_agent_hitl',
      edges: [
        [
          'START',
          node(requestInputFn, {name: 'request_input_fn'}),
          node(processInputFn, {
            name: 'process_input_fn',
            parameters: z.object({nodeInput: z.object({text: z.string()})}),
          }),
        ],
      ],
    });

    // Driven through the Runner, as the reference is. The requesting node does
    // not rerun on resume, so the reply becomes its output and feeds the next
    // node: Python's two-node pattern.
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent: wf, sessionService});

    const turn1: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'start workflow'}]},
    })) {
      turn1.push(event);
    }

    const requestEvents = turn1.filter(hasRequestInputFunctionCall);
    expect(requestEvents).toHaveLength(1);
    const interruptId = getRequestInputInterruptIds(requestEvents[0])[0];
    expect(requestEvents[0].content?.parts?.[0]?.functionCall?.id).toBe(
      interruptId,
    );

    const turn2: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          createRequestInputResponse(interruptId, {text: 'Hello from user'}),
        ],
      },
    })) {
      turn2.push(event);
    }

    expect(
      turn2.filter((e) => e.output === 'received: Hello from user'),
    ).toHaveLength(1);
  });
});

describe('FunctionNode parity — ctx.state deltas', () => {
  it('test_function_node_ctx_state_delta_sync', async () => {
    const setStateViaCtx = (ctx: NodeContext) => {
      ctx.state.set('userRequest', 'build a tracker app');
      return 'done';
    };
    const readState = (
      _ctx: NodeContext,
      {userRequest}: {userRequest: string},
    ) => `request=${userRequest}`;
    const wf = new Workflow({
      name: 'test_ctx_state_delta_sync',
      edges: [
        [
          'START',
          node(setStateViaCtx, {name: 'set_state_via_ctx'}),
          node(readState, {
            name: 'read_state',
            parameters: z.object({userRequest: z.string()}),
          }),
        ],
      ],
    });

    const {events} = await driveWorkflow(wf, 'start');

    expect(outputs(events)).toEqual(['done', 'request=build a tracker app']);
    expect(events[0].actions.stateDelta).toEqual({
      userRequest: 'build a tracker app',
    });
  });

  it('test_function_node_ctx_state_delta_async', async () => {
    const setStateViaCtx = async (ctx: NodeContext) => {
      ctx.state.set('counter', 42);
      ctx.state.set('name', 'test');
      return 'set';
    };
    const readState = (
      _ctx: NodeContext,
      {counter, name}: {counter: number; name: string},
    ) => `counter=${counter}, name=${name}`;
    const wf = new Workflow({
      name: 'test_ctx_state_delta_async',
      edges: [
        [
          'START',
          node(setStateViaCtx, {name: 'set_state_via_ctx'}),
          node(readState, {
            name: 'read_state',
            parameters: z.object({counter: z.number(), name: z.string()}),
          }),
        ],
      ],
    });

    const {events} = await driveWorkflow(wf, 'start');

    expect(outputs(events)).toEqual(['set', 'counter=42, name=test']);
    expect(events[0].actions.stateDelta).toEqual({counter: 42, name: 'test'});
  });

  it('test_function_node_ctx_state_delta_none_return', async () => {
    const setStateReturnNone = (ctx: NodeContext) => {
      ctx.state.set('myKey', 'my_value');
      return null;
    };
    const readState = (_ctx: NodeContext, {myKey}: {myKey: string}) =>
      `myKey=${myKey}`;
    const wf = new Workflow({
      name: 'test_ctx_state_delta_none_return',
      edges: [
        [
          'START',
          node(setStateReturnNone, {name: 'set_state_return_none'}),
          node(readState, {
            name: 'read_state',
            parameters: z.object({myKey: z.string()}),
          }),
        ],
      ],
    });

    const {events} = await driveWorkflow(wf, 'start');

    expect(events[0].output).toBeUndefined();
    expect(events[0].actions.stateDelta).toEqual({myKey: 'my_value'});
    expect(events.at(-1)?.output).toBe('myKey=my_value');
  });

  it('test_function_node_ctx_state_delta_with_event_return', async () => {
    const setStateReturnEvent = (ctx: NodeContext) => {
      ctx.state.set('fromCtx', 'ctx_value');
      return createEvent({
        output: 'result',
        actions: {stateDelta: {fromEvent: 'event_value'}},
      });
    };
    const readState = (
      _ctx: NodeContext,
      {fromCtx, fromEvent}: {fromCtx: string; fromEvent: string},
    ) => `fromCtx=${fromCtx}, fromEvent=${fromEvent}`;
    const wf = new Workflow({
      name: 'test_ctx_state_delta_event_return',
      edges: [
        [
          'START',
          node(setStateReturnEvent, {name: 'set_state_return_event'}),
          node(readState, {
            name: 'read_state',
            parameters: z.object({
              fromCtx: z.string(),
              fromEvent: z.string(),
            }),
          }),
        ],
      ],
    });

    const {events} = await driveWorkflow(wf, 'start');

    expect(events[0].output).toBe('result');
    expect(events[0].actions.stateDelta).toEqual({
      fromEvent: 'event_value',
      fromCtx: 'ctx_value',
    });
    expect(events.at(-1)?.output).toBe(
      'fromCtx=ctx_value, fromEvent=event_value',
    );
  });

  it('test_function_node_ctx_state_delta_generator', async () => {
    const genWithState = function* (ctx: NodeContext) {
      ctx.state.set('key1', 'value1');
      yield createEvent({actions: {stateDelta: {key1: 'value1'}}});
      ctx.state.set('key2', 'value2');
      yield 'done';
    };
    const readState = (
      _ctx: NodeContext,
      {key1, key2}: {key1: string; key2: string},
    ) => `key1=${key1}, key2=${key2}`;
    const wf = new Workflow({
      name: 'test_ctx_state_delta_generator',
      edges: [
        [
          'START',
          node(genWithState, {name: 'gen_with_state'}),
          node(readState, {
            name: 'read_state',
            parameters: z.object({key1: z.string(), key2: z.string()}),
          }),
        ],
      ],
    });

    const {events} = await driveWorkflow(wf, 'start');

    // adk-js attaches each written key to exactly one emitted event; Python
    // re-reads the whole accumulated delta on every event. The per-key result
    // is the same here.
    expect(events[0].output).toBeUndefined();
    expect(events[0].actions.stateDelta).toEqual({key1: 'value1'});
    expect(events[1].output).toBe('done');
    expect(events[1].actions.stateDelta).toEqual({key2: 'value2'});
    expect(events[2].output).toBe('key1=value1, key2=value2');
  });
});

describe('FunctionNode parity — outputSchema', () => {
  it('test_output_schema_inferred_validates_dict', async () => {
    const produce = () => ({name: 'test', value: 42});
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', node(produce, {name: 'produce', outputSchema: OutputModel})],
      ],
    });

    const {output} = await driveWorkflow(wf, 'go');

    expect(output).toEqual({name: 'test', value: 42});
  });

  it('test_output_schema_inferred_rejects_invalid', async () => {
    const produce = () => ({name: 'test'});
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', node(produce, {name: 'produce', outputSchema: OutputModel})],
      ],
    });

    await expect(driveWorkflow(wf, 'go')).rejects.toThrow();
  });

  it('test_output_schema_inferred_rejects_wrong_type', async () => {
    const produce = () => 'not a dict';
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', node(produce, {name: 'produce', outputSchema: OutputModel})],
      ],
    });

    await expect(driveWorkflow(wf, 'go')).rejects.toThrow();
  });

  it('test_output_schema_generator_rejects_invalid_item', async () => {
    const produceItems = function* () {
      yield {name: 'a', value: 1};
      yield {name: 'bad'};
    };
    const wf = new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(produceItems, {
            name: 'produce_items',
            outputSchema: OutputModel,
          }),
        ],
      ],
    });

    await expect(driveWorkflow(wf, 'go')).rejects.toThrow();
  });

  it('test_output_schema_inferred_coerces_defaults', async () => {
    const produce = () => ({name: 'test', value: 5});
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', node(produce, {name: 'produce', outputSchema: OtherModel})],
      ],
    });

    const {output} = await driveWorkflow(wf, 'go');

    expect(output).toEqual({name: 'test', value: 5, extra: 'default'});
  });

  it('test_output_schema_inferred_type_coercion', async () => {
    const produce = () => ({name: 'coerce', value: '42'});
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', node(produce, {name: 'produce', outputSchema: OutputModel})],
      ],
    });

    // Divergence: Pydantic coerces the string '42' to 42, Zod rejects it. The
    // assertion pins what adk-js does; the implementation is not bent to make
    // the reference assertion pass.
    await expect(driveWorkflow(wf, 'go')).rejects.toThrow();
  });

  it('test_output_schema_none_return', async () => {
    const produceNone = () => null;
    const downstream = (_ctx: NodeContext, input: unknown) => `got: ${input}`;
    const wf = new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(produceNone, {name: 'produce_none', outputSchema: OutputModel}),
          node(downstream, {name: 'downstream'}),
        ],
      ],
    });

    const {output} = await driveWorkflow(wf, 'go');

    expect(output).toBe('got: undefined');
  });

  it('test_output_schema_validates_returned_event_data', async () => {
    const produce = () => createEvent({output: {name: 'evt', value: 7}});
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', node(produce, {name: 'produce', outputSchema: OutputModel})],
      ],
    });

    const {output} = await driveWorkflow(wf, 'go');

    expect(output).toEqual({name: 'evt', value: 7});
  });

  it('test_output_schema_rejects_invalid_returned_event_data', async () => {
    const produce = () => createEvent({output: {wrongField: 'oops'}});
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', node(produce, {name: 'produce', outputSchema: OutputModel})],
      ],
    });

    await expect(driveWorkflow(wf, 'go')).rejects.toThrow();
  });

  it('test_output_schema_no_inference_for_non_basemodel', () => {
    const produce = () => ({any: 'thing'});

    // Not portable as written: Python infers `output_schema` from the return
    // hint, and TypeScript keeps no return type at runtime. A node therefore
    // never infers one, which is the behaviour this pins.
    expect(new FunctionNode(produce).outputSchema).toBeUndefined();
  });

  it('test_output_schema_inferred_from_return_hint', () => {
    const produce = () => ({name: 'inferred', value: 1});

    // Not portable: see `test_output_schema_no_inference_for_non_basemodel`.
    // Nothing short of a compiler plugin recovers a return type at runtime, so
    // `outputSchema` stays an explicit config field.
    expect(new FunctionNode(produce).outputSchema).toBeUndefined();
    expect(
      new FunctionNode(produce, {outputSchema: OutputModel}).outputSchema,
    ).toBe(OutputModel);
  });
});

describe('FunctionNode parity — inputSchema', () => {
  /** A node that records the bound `nodeInput` it receives. */
  function recorder(
    received: unknown[],
    parameters: z.ZodType,
  ): ReturnType<typeof node> {
    return node(
      (_ctx: NodeContext, {nodeInput}: {nodeInput: unknown}) => {
        received.push(nodeInput);
        return 'ok';
      },
      {name: 'process', parameters},
    );
  }

  it('test_input_schema_validates_dict', async () => {
    const received: unknown[] = [];
    const process = recorder(received, z.object({nodeInput: OutputModel}));

    expect(process.inputSchema).toBe(OutputModel);

    const wf = new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(() => ({name: 'test', value: 42}), {name: 'produce'}),
          process,
        ],
      ],
    });
    await driveWorkflow(wf, 'go');

    expect(received).toEqual([{name: 'test', value: 42}]);
  });

  it('test_input_schema_rejects_invalid_dict', async () => {
    const received: unknown[] = [];
    const wf = new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(() => ({name: 'test'}), {name: 'produce'}),
          recorder(received, z.object({nodeInput: OutputModel})),
        ],
      ],
    });

    await expect(driveWorkflow(wf, 'go')).rejects.toThrow();
    expect(received).toEqual([]);
  });

  it('test_input_schema_coerces_types', async () => {
    const received: unknown[] = [];
    const wf = new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(() => ({name: 'test', value: '5'}), {name: 'produce'}),
          recorder(received, z.object({nodeInput: OutputModel})),
        ],
      ],
    });

    // Divergence: Pydantic coerces '5' to 5, Zod rejects it.
    await expect(driveWorkflow(wf, 'go')).rejects.toThrow();
  });

  it('test_input_schema_fills_defaults', async () => {
    const received: unknown[] = [];
    const process = recorder(received, z.object({nodeInput: OtherModel}));

    expect(process.inputSchema).toBe(OtherModel);

    const wf = new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(() => ({name: 'test', value: 1}), {name: 'produce'}),
          process,
        ],
      ],
    });
    await driveWorkflow(wf, 'go');

    expect(received).toEqual([{name: 'test', value: 1, extra: 'default'}]);
  });

  it('test_input_schema_no_inference_for_non_basemodel', () => {
    const process = (_ctx: NodeContext, input: unknown) => `ok ${input}`;

    // Not portable as written: a node that declares no `parameters` infers no
    // `inputSchema`, because there is no signature to read.
    expect(new FunctionNode(process).inputSchema).toBeUndefined();
  });

  it('test_input_schema_none_passthrough', async () => {
    const received: unknown[] = [];
    const process = (
      _ctx: NodeContext,
      {nodeInput}: {nodeInput?: z.infer<typeof OutputModel>},
    ) => {
      received.push(nodeInput);
      return `got: ${nodeInput}`;
    };
    const wf = new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(() => null, {name: 'produce_none'}),
          node(process, {
            name: 'process',
            parameters: z.object({nodeInput: OutputModel.optional()}),
          }),
        ],
      ],
    });

    const {output} = await driveWorkflow(wf, 'go');

    expect(received).toEqual([undefined]);
    expect(output).toBe('got: undefined');
  });
});

describe('FunctionNode parity — authConfig', () => {
  const apiKeyAuthConfig = (): AuthConfig => ({
    authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'} as AuthScheme,
    rawAuthCredential: {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'placeholder',
    },
    credentialKey: 'test_key',
  });

  it('test_raises_without_rerun_on_resume', () => {
    expect(
      () => new FunctionNode('n', () => null, {authConfig: apiKeyAuthConfig()}),
    ).toThrow('rerunOnResume: true');
  });

  it('test_no_auth_config_default', () => {
    expect(new FunctionNode('n', () => null).authConfig).toBeUndefined();
  });

  it('test_rerun_on_resume_explicit_true_with_auth', () => {
    const built = new FunctionNode('n', () => null, {
      authConfig: apiKeyAuthConfig(),
      rerunOnResume: true,
    });

    expect(built.rerunOnResume).toBe(true);
    expect(built.authConfig).toBeDefined();
  });
});

describe("FunctionNode parity — parameterBinding 'nodeInput'", () => {
  const addParameters = z.object({x: z.number(), y: z.number()});
  const add = (_ctx: NodeContext, {x, y}: {x: number; y: number}) => x + y;

  it('test_schemas_inferred_from_signature', () => {
    const built = new FunctionNode(add, {
      name: 'add',
      parameters: addParameters,
      parameterBinding: 'nodeInput',
    });

    expect(built.parameterBinding).toBe('nodeInput');
    expect(built.inputSchema).toBe(addParameters);
    // Divergence: no return type survives to runtime, so `outputSchema` is not
    // inferred. Python reads it off the `-> int` hint.
    expect(built.outputSchema).toBeUndefined();
  });

  it('test_ctx_param_excluded_from_schema', () => {
    const greet = (_ctx: NodeContext, {name}: {name: string}) =>
      `Hello, ${name}!`;
    const built = new FunctionNode(greet, {
      name: 'greet',
      parameters: z.object({name: z.string()}),
      parameterBinding: 'nodeInput',
    });

    // `ctx` is a positional argument in TypeScript, never a declared
    // parameter, so Python's `ignore_params` exclusion has nothing to do. The
    // absence is structural.
    const properties = (built.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    expect(Object.keys(properties)).toEqual(['name']);
  });

  it.each([
    {id: 'all_params_provided', produced: {x: 3, y: 4}, expected: 7},
    {id: 'missing_param_uses_default', produced: {x: 5}, expected: 15},
  ])('test_bind_from_node_input ($id)', async ({produced, expected}) => {
    const built = new FunctionNode(add, {
      name: 'add',
      parameters: z.object({x: z.number(), y: z.number().default(10)}),
      parameterBinding: 'nodeInput',
    });
    const wf = new Workflow({
      name: 'test_bind_from_node_input',
      edges: [['START', node(() => produced, {name: 'produce'}), built]],
    });

    const {events} = await driveWorkflow(wf, 'go');

    expect(outputs(events)).toEqual([produced, expected]);
  });

  it('test_bind_from_node_input_missing_required', async () => {
    const built = new FunctionNode(add, {
      name: 'add',
      parameters: addParameters,
      parameterBinding: 'nodeInput',
    });
    const wf = new Workflow({
      name: 'test_bind_node_input_missing',
      edges: [['START', node(() => ({x: 5}), {name: 'produce'}), built]],
    });

    // Divergence: the node's `inputSchema` is the declared parameter schema,
    // and `BaseNode.validateInput` enforces it before binding runs, so the
    // missing key is reported as a node input-schema failure. Python's
    // `input_schema` in this mode is a plain dict, which its validator ignores,
    // so it reaches the binding error instead. `parameter_binding_test.ts`
    // covers the binding error itself.
    await expect(driveWorkflow(wf, 'go')).rejects.toThrow(/inputSchema/);
  });

  it('test_bind_from_node_input_with_ctx', async () => {
    const receivedCtx: NodeContext[] = [];
    const greet = (ctx: NodeContext, {name}: {name: string}) => {
      receivedCtx.push(ctx);
      return `Hello, ${name}!`;
    };
    const built = new FunctionNode(greet, {
      name: 'greet',
      parameters: z.object({name: z.string()}),
      parameterBinding: 'nodeInput',
    });
    const wf = new Workflow({
      name: 'test_bind_node_input_ctx',
      edges: [
        ['START', node(() => ({name: 'Alice'}), {name: 'produce'}), built],
      ],
    });

    const {events} = await driveWorkflow(wf, 'go');

    expect(receivedCtx).toHaveLength(1);
    expect(receivedCtx[0]).toBeInstanceOf(NodeContext);
    expect(outputs(events)).toEqual([{name: 'Alice'}, 'Hello, Alice!']);
  });

  it('test_model_copy_preserves_parameter_binding', () => {
    const built = new FunctionNode(add, {
      name: 'add',
      parameters: addParameters,
      parameterBinding: 'nodeInput',
    });

    // adk-js clones through `node(existingNode, {name})`, which is what
    // Python's `model_copy(update={'name': ...})` does here.
    const copied = node(built, {name: 'add_copy'}) as FunctionNode;

    expect(copied.name).toBe('add_copy');
    expect(copied.parameterBinding).toBe('nodeInput');
    expect(copied.inputSchema).toBe(addParameters);
  });
});
