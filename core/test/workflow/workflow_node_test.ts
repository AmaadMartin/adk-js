/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/workflow/test_workflow_node.py`, read on `main` at commit
 * `25f5214c83f56b2fcffd35757e886026632f3c2b`.
 *
 * Each `it(...)` keeps its Python test name verbatim, so a reader can find the
 * original. Two of the 18 reference tests are not ported (`parameter_binding`
 * has no adk-js equivalent) and two are covered elsewhere
 * (`test_tool_node_state_delta` by `tool_node_test.ts`,
 * `test_parallel_worker_invalid_max_parallel_workers_less_than_one` by
 * `parallel_worker_test.ts`).
 */

import {
  BaseTool,
  Event,
  FunctionNode,
  node,
  NodeContext,
  ParallelWorker,
  ToolNode,
  Workflow,
  WorkflowNode,
  WorkflowNodeConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {driveWorkflow, PlainReplyAgent, replyAgent} from './test_helpers.js';

/**
 * Extracts `[nodeName, output]` for every child-node event, mirroring the
 * reference file's `_output_by_node`. adk-js separates path segments with `.`
 * where adk-python uses `/`.
 */
function outputsByNode(events: Event[]): Array<[string, unknown]> {
  const results: Array<[string, unknown]> = [];
  for (const event of events) {
    const path = event.nodeInfo?.path;
    if (event.output === undefined || !path?.includes('.')) {
      continue;
    }
    const segment = path.slice(path.lastIndexOf('.') + 1);
    results.push([segment.split('@')[0], event.output]);
  }
  return results;
}

/** A tool that echoes its args, standing in for the reference `MyTool`. */
class EchoTool extends BaseTool {
  constructor() {
    super({name: 'tool', description: 'desc'});
  }
  async runAsync({args}: {args: Record<string, unknown>}): Promise<unknown> {
    return {echoed: args};
  }
}

/** Configuration for {@link CustomNode}, the reference `_CustomNode`. */
interface CustomNodeConfig extends WorkflowNodeConfig {
  customVal?: string;
}

/** The reference `_CustomNode`: a subclass carrying a field of its own. */
class CustomNode extends WorkflowNode<string, string> {
  readonly customVal: string;

  constructor(config: CustomNodeConfig) {
    super({rerunOnResume: true, ...config});
    this.customVal = config.customVal ?? 'hello';
  }

  protected async *runNodeImpl(_ctx: NodeContext, input: string) {
    yield `subclass: ${this.customVal} -> ${input}`;
  }
}

describe('node() — ported from adk-python test_workflow_node.py', () => {
  it('test_node_decorator', async () => {
    const myFunc = node({name: 'decorated_node'})(
      () => 'Hello from decorated_func',
    );
    expect(myFunc.name).toBe('decorated_node');

    const wf = new Workflow({name: 'test_agent', edges: [['START', myFunc]]});
    const {events} = await driveWorkflow(wf);

    expect(outputsByNode(events)).toContainEqual([
      'decorated_node',
      'Hello from decorated_func',
    ]);
  });

  it('test_node_parallel_worker_instance', () => {
    // The wrapper takes its name from the wrapped function, so the binding it
    // is assigned to must not shadow that function's own name.
    const wrapped = node({parallelWorker: true})(function myFunc(
      _ctx: NodeContext,
      input: unknown,
    ) {
      return input;
    });

    expect(wrapped).toBeInstanceOf(ParallelWorker);
    expect(wrapped.name).toBe('myFunc');

    function otherFunc(_ctx: NodeContext, x: unknown) {
      return x;
    }

    const parallelNode = node(otherFunc, {parallelWorker: true});
    expect(parallelNode).toBeInstanceOf(ParallelWorker);
    expect(parallelNode.name).toBe('otherFunc');
  });

  it('test_node_parallel_worker_execution', async () => {
    const doubler = node({parallelWorker: true})(async function myFunc(
      _ctx: NodeContext,
      input: number,
    ) {
      return input * 2;
    });

    function producerFunc() {
      return [1, 2, 3];
    }

    const wf = new Workflow({
      name: 'test_agent',
      edges: [['START', producerFunc, doubler]],
    });
    const {events} = await driveWorkflow(wf);

    const byNode = outputsByNode(events);
    expect(byNode).toContainEqual(['producerFunc', [1, 2, 3]]);
    expect(byNode).toContainEqual(['myFunc', [2, 4, 6]]);
  });

  it('test_node_decorator_rerun_on_resume', () => {
    const myFunc = node({name: 'decorated_node', rerunOnResume: true})(
      () => 'Hello from decorated_func',
    );
    expect(myFunc).toBeInstanceOf(FunctionNode);
    expect(myFunc.rerunOnResume).toBe(true);

    const bare = node()(function myFunc2() {
      return 'Hello from decorated_func2';
    });
    expect(bare).toBeInstanceOf(FunctionNode);
    expect(bare.name).toBe('myFunc2');
    expect(bare.rerunOnResume).toBe(false);
  });

  it('test_node_function_with_base_node', () => {
    const original = node({name: 'original'})(() => null);

    const wrapped = node(original, {name: 'overridden', rerunOnResume: true});

    expect(wrapped).toBeInstanceOf(FunctionNode);
    expect(wrapped).not.toBe(original);
    expect(wrapped.name).toBe('overridden');
    expect(wrapped.rerunOnResume).toBe(true);
  });

  it('test_node_no_unnecessary_wrap', () => {
    const llmAgent = replyAgent('llm');
    const llmNode = node(llmAgent, {name: 'overridden_llm'});
    expect(llmNode.name).toBe('overridden_llm');
    // The reference also asserts `llm_node.mode == 'single_turn'`. adk-js
    // leaves `LlmAgent.mode` undefined when it is not given, so that assertion
    // has no adk-js counterpart.

    const agent = new PlainReplyAgent('agent');
    const agentNode = node(agent, {
      name: 'overridden_agent',
      rerunOnResume: true,
    });
    expect(agentNode.name).toBe('overridden_agent');
    expect(agentNode.rerunOnResume).toBe(true);

    const toolNode = node(new EchoTool(), {name: 'overridden_tool'});
    expect(toolNode).toBeInstanceOf(ToolNode);
    expect(toolNode.name).toBe('overridden_tool');

    function myFunc() {
      return null;
    }
    const funcNode = node(myFunc, {
      name: 'overridden_func',
      rerunOnResume: true,
    });
    expect(funcNode).toBeInstanceOf(FunctionNode);
    expect(funcNode.name).toBe('overridden_func');
    expect(funcNode.rerunOnResume).toBe(true);
  });

  it('test_node_subclassing_model_copy_preserves_identity', async () => {
    const nodeInst = new CustomNode({
      name: 'subclass',
      parallelWorker: true,
      customVal: 'barrier',
    });
    expect(nodeInst.parallelWorker).toBe(true);

    const cloned = nodeInst.clone();
    expect(cloned).toBeInstanceOf(CustomNode);
    expect(cloned.customVal).toBe('barrier');
    expect(cloned.parallelWorker).toBe(true);

    // The reference reads `cloned._inner_node._node`, which is private here.
    // Running the copy asserts the same three properties: it has a wrapper (it
    // fanned out), the wrapper holds a `CustomNode` copy (`runNodeImpl` ran
    // with `customVal`), and that copy has `parallelWorker` off (it produced
    // one output per item instead of recursing).
    const wf = new Workflow({name: 'copy_wf', edges: [['START', cloned]]});
    const {output} = await driveWorkflow(wf, ['a', 'b']);
    expect(output).toEqual([
      'subclass: barrier -> a',
      'subclass: barrier -> b',
    ]);
  });

  it('test_node_subclassing_execution_with_parallel_worker', async () => {
    const subclassNode = new CustomNode({
      name: 'subclass',
      parallelWorker: true,
      customVal: 'workflow',
    });

    async function producer() {
      return ['input1', 'input2'];
    }

    const wf = new Workflow({
      name: 'test_agent',
      edges: [['START', producer, subclassNode]],
    });
    const {events} = await driveWorkflow(wf);

    const byNode = outputsByNode(events);
    expect(byNode).toContainEqual(['producer', ['input1', 'input2']]);
    expect(byNode).toContainEqual([
      'subclass',
      ['subclass: workflow -> input1', 'subclass: workflow -> input2'],
    ]);
  });

  it('test_node_decorator_parallel_worker_max_parallel_workers', () => {
    const myFunc = node({parallelWorker: true, maxParallelWorkers: 3})(
      function myFunc(_ctx: NodeContext, input: unknown) {
        return input;
      },
    );

    expect(myFunc).toBeInstanceOf(ParallelWorker);
    expect((myFunc as ParallelWorker).maxParallelWorkers).toBe(3);
  });

  it('test_node_decorator_invalid_max_parallel_workers', () => {
    expect(() => node({parallelWorker: false, maxParallelWorkers: 3})).toThrow(
      'maxParallelWorkers can only be set when parallelWorker is true.',
    );
  });

  it('test_node_subclass_invalid_max_parallel_workers', () => {
    expect(
      () =>
        new CustomNode({
          name: 'subclass',
          parallelWorker: false,
          maxParallelWorkers: 3,
        }),
    ).toThrow(
      'maxParallelWorkers can only be set when parallelWorker is true.',
    );
  });

  it('test_node_subclassing_model_copy_preserves_max_parallel_workers', () => {
    const nodeInst = new CustomNode({
      name: 'subclass',
      parallelWorker: true,
      maxParallelWorkers: 5,
      customVal: 'barrier',
    });
    expect(nodeInst.parallelWorker).toBe(true);
    expect(nodeInst.maxParallelWorkers).toBe(5);

    const cloned = nodeInst.clone();
    expect(cloned).toBeInstanceOf(CustomNode);
    expect(cloned.parallelWorker).toBe(true);
    // The reference reads the limit off `cloned._inner_node`; the public field
    // is what the copy builds its wrapper from. That the wrapper honours it is
    // asserted in `workflow_node_parallel_test.ts`.
    expect(cloned.maxParallelWorkers).toBe(5);
  });

  it('test_node_decorator_invalid_max_parallel_workers_less_than_one', () => {
    expect(() => node({parallelWorker: true, maxParallelWorkers: 0})).toThrow(
      'maxParallelWorkers must be greater than or equal to 1.',
    );
  });

  it('test_node_subclass_invalid_max_parallel_workers_less_than_one', () => {
    expect(
      () =>
        new CustomNode({
          name: 'subclass',
          parallelWorker: true,
          maxParallelWorkers: 0,
        }),
    ).toThrow('maxParallelWorkers must be greater than or equal to 1.');
  });
});
