/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports of `tests/unittests/workflow/test_workflow_node.py` on
 * `google/adk-python` `main`. Each `it(...)` keeps its Python test name, so a
 * reviewer can grep the reference file for it.
 *
 * Of the 18 reference tests: 14 are ported here, 2 are not portable
 * (`test_node_decorator_parameter_binding` and its execution twin —
 * `parameterBinding` does not exist in adk-js), and 2 are already covered
 * (`test_tool_node_state_delta` by `tool_node_test.ts` 'propagates tool context
 * state writes onto the emitted event';
 * `test_parallel_worker_invalid_max_parallel_workers_less_than_one` by
 * `parallel_worker_test.ts` 'rejects maxParallelWorkers < 1').
 *
 * Python asserts against private state (`_inner_node`, `_inner_node._node`).
 * Those assertions are made here through the public surface instead: `clone()`
 * for the copy the worker wraps, and the fan-out output for the run.
 */

import {describe, expect, it} from 'vitest';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {BaseTool} from '../../src/tools/base_tool.js';
import {BaseNode} from '../../src/workflow/base_node.js';
import {node, WorkflowNode} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {ParallelWorker} from '../../src/workflow/nodes/parallel_worker.js';
import {ToolNode} from '../../src/workflow/nodes/tool_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveNode, PlainReplyAgent, replyAgent} from './test_helpers.js';

/** Mirrors the reference file's `_CustomNode`. */
class CustomNode extends WorkflowNode<string, string> {
  readonly customVal: string;

  constructor(config: {
    name: string;
    customVal?: string;
    parallelWorker?: boolean;
    maxParallelWorkers?: number;
  }) {
    super({rerunOnResume: true, ...config});
    this.customVal = config.customVal ?? 'hello';
  }

  protected async *runNodeImpl(_ctx: NodeContext, input: string) {
    yield `subclass: ${this.customVal} -> ${input}`;
  }
}

/** A tool that echoes its args, standing in for the reference `MyTool`. */
class EchoTool extends BaseTool {
  constructor() {
    super({name: 'tool', description: 'desc'});
  }
  async runAsync({args}: {args: Record<string, unknown>}): Promise<unknown> {
    return args;
  }
}

/**
 * Handlers are declared here, not inline, because a named function expression
 * that shadows the `const` it is assigned to is renamed by the bundler — and
 * `node()` derives a node's name from `Function.prototype.name`.
 */
function myFunc(_ctx: NodeContext, input: unknown) {
  return input;
}

function myFunc2() {
  return 'Hello from decorated_func2';
}

function otherFunc(_ctx: NodeContext, x: unknown) {
  return x;
}

function double(_ctx: NodeContext, input: number) {
  return input * 2;
}

function produceNumbers() {
  return [1, 2, 3];
}

function produceInputs() {
  return ['input1', 'input2'];
}

/** Runs a workflow to completion and returns its output. */
async function runWorkflow(wf: Workflow, input?: unknown): Promise<unknown> {
  return (await driveNode(wf, input)).output;
}

describe('workflow node — ported from adk-python test_workflow_node.py', () => {
  it('test_node_decorator', async () => {
    const myFunc = node({name: 'decorated_node'})(
      () => 'Hello from decorated_func',
    );
    expect(myFunc.name).toBe('decorated_node');

    const wf = new Workflow({name: 'test_agent', edges: [['START', myFunc]]});
    expect(await runWorkflow(wf)).toBe('Hello from decorated_func');
  });

  it('test_node_parallel_worker_instance', () => {
    const built = node({parallelWorker: true})(myFunc);
    expect(built).toBeInstanceOf(ParallelWorker);
    expect(built.name).toBe('myFunc');

    const parallelNode = node(otherFunc, {parallelWorker: true});
    expect(parallelNode).toBeInstanceOf(ParallelWorker);
    expect(parallelNode.name).toBe('otherFunc');
  });

  it('test_node_parallel_worker_execution', async () => {
    const doubler = node({parallelWorker: true})(double);
    const producer = node(produceNumbers);

    const wf = new Workflow({
      name: 'test_agent',
      edges: [['START', producer, doubler]],
    });
    expect(await runWorkflow(wf)).toEqual([2, 4, 6]);
  });

  it('test_node_decorator_rerun_on_resume', () => {
    const myFunc = node({name: 'decorated_node', rerunOnResume: true})(
      () => 'Hello from decorated_func',
    );
    expect(myFunc).toBeInstanceOf(FunctionNode);
    expect(myFunc.rerunOnResume).toBe(true);

    const plain = node()(myFunc2);
    expect(plain).toBeInstanceOf(FunctionNode);
    expect(plain.name).toBe('myFunc2');
    expect(plain.rerunOnResume).toBe(false);
  });

  it('test_node_function_with_base_node', () => {
    const original = node({name: 'original'})(() => undefined);
    const wrapped = node(original, {name: 'overridden', rerunOnResume: true});

    expect(wrapped).toBeInstanceOf(FunctionNode);
    expect(wrapped).not.toBe(original);
    expect(wrapped.name).toBe('overridden');
    expect(wrapped.rerunOnResume).toBe(true);
  });

  it('test_node_no_unnecessary_wrap', () => {
    // The reference also asserts `llm_node.mode == 'single_turn'`; adk-js's
    // LlmAgent has no `mode` field, so that assertion has no counterpart.
    const llmAgent = replyAgent('llm');
    const llmNode = node(llmAgent, {name: 'overridden_llm'});
    expect(llmNode).toBeInstanceOf(LlmAgent);
    expect(llmNode.name).toBe('overridden_llm');

    const agent = new PlainReplyAgent('agent');
    const agentNode = node(agent, {
      name: 'overridden_agent',
      rerunOnResume: true,
    });
    expect(agentNode).toBeInstanceOf(PlainReplyAgent);
    expect(agentNode.name).toBe('overridden_agent');
    expect(agentNode.rerunOnResume).toBe(true);

    const toolNode = node(new EchoTool(), {name: 'overridden_tool'});
    expect(toolNode).toBeInstanceOf(ToolNode);
    expect(toolNode.name).toBe('overridden_tool');

    const funcNode = node(() => undefined, {
      name: 'overridden_func',
      rerunOnResume: true,
    });
    expect(funcNode).toBeInstanceOf(FunctionNode);
    expect(funcNode.name).toBe('overridden_func');
    expect(funcNode.rerunOnResume).toBe(true);
  });

  it('test_node_subclassing_model_copy_preserves_identity', () => {
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

    // Python reads `cloned._inner_node._node`; this is the copy the worker
    // wraps, taken the same way `createParallelWorker` takes it.
    const innerCopy = cloned.clone({parallelWorker: false});
    expect(innerCopy).toBeInstanceOf(CustomNode);
    expect(innerCopy.customVal).toBe('barrier');
    expect(innerCopy.parallelWorker).toBe(false);
  });

  it('test_node_subclassing_execution_with_parallel_worker', async () => {
    const subclassNode = new CustomNode({
      name: 'subclass',
      parallelWorker: true,
      customVal: 'workflow',
    });
    const wf = new Workflow({
      name: 'test_agent',
      edges: [['START', node(produceInputs), subclassNode]],
    });
    expect(await runWorkflow(wf)).toEqual([
      'subclass: workflow -> input1',
      'subclass: workflow -> input2',
    ]);
  });

  it('test_node_decorator_parallel_worker_max_parallel_workers', () => {
    const built = node({parallelWorker: true, maxParallelWorkers: 3})(myFunc);
    if (!(built instanceof ParallelWorker)) {
      expect.fail('node() did not build a ParallelWorker');
    }
    expect(built.maxParallelWorkers).toBe(3);
  });

  it('test_node_decorator_invalid_max_parallel_workers', () => {
    expect(() => node({parallelWorker: false, maxParallelWorkers: 3})).toThrow(
      'maxParallelWorkers can only be set when parallelWorker is true.',
    );
  });

  it('test_node_subclass_invalid_max_parallel_workers', () => {
    // adk-js throws a plain `Error`, where pydantic raises `ValidationError`;
    // the message is the reference message, camelCased for the option names.
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
    expect(cloned.maxParallelWorkers).toBe(5);
    expect(cloned.clone({parallelWorker: false}).parallelWorker).toBe(false);

    // Python reads `cloned._inner_node.max_parallel_workers`; the worker is
    // built through the `protected` seam instead of reaching into the memo.
    const worker = new InspectableNode({
      name: 'subclass',
      parallelWorker: true,
      maxParallelWorkers: 5,
      customVal: 'barrier',
    }).buildWorker();
    if (!(worker instanceof ParallelWorker)) {
      expect.fail('createParallelWorker did not build a ParallelWorker');
    }
    expect(worker.maxParallelWorkers).toBe(5);
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

/** Exposes the `protected` worker seam, the way a real subclass would. */
class InspectableNode extends CustomNode {
  buildWorker(): BaseNode | undefined {
    return this.createParallelWorker();
  }
}
