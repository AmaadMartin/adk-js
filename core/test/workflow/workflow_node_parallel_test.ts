/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-js half of the parallel-worker `WorkflowNode`: the call-form
 * disambiguation `node()` needs and TypeScript's construction order, neither of
 * which the adk-python reference tests have a counterpart for. The ported
 * reference tests live in `workflow_node_test.ts`.
 */

import {describe, expect, it} from 'vitest';
import {BaseNode} from '../../src/workflow/base_node.js';
import {isWorkflowNode, node, WorkflowNode} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {ParallelWorker} from '../../src/workflow/nodes/parallel_worker.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveNode} from './test_helpers.js';

/** A subclass that reports the field its own constructor body assigns. */
class TaggedNode extends WorkflowNode<string, string> {
  private readonly tag: string;

  constructor(config: {
    name: string;
    tag: string;
    parallelWorker?: boolean;
    maxParallelWorkers?: number;
    rerunOnResume?: boolean;
  }) {
    super(config);
    this.tag = config.tag;
  }

  protected async *runNodeImpl(_ctx: NodeContext, input: string) {
    yield `${this.tag}/${this.name}: ${input}`;
  }
}

/** A node whose fan-out wrapper is never available. */
class WorkerlessNode extends TaggedNode {
  protected override createParallelWorker(): BaseNode | undefined {
    return undefined;
  }
}

function greet() {
  return 'hi';
}

describe('node() options-only form', () => {
  it('returns a wrapper building a plain FunctionNode when called with no arguments', () => {
    const built = node()(greet);
    expect(built).toBeInstanceOf(FunctionNode);
    expect(built.name).toBe('greet');
    expect(built.rerunOnResume).toBe(false);
  });

  it('rejects a plain object carrying a key that is not an option', () => {
    // The disambiguation cannot be a bare plain-object check: this object has
    // to fall through to buildNode and be rejected there.
    const fakeAgent = {name: 'a', runAsync: async function* () {}};
    expect(() => node(fakeAgent as unknown as never)).toThrow(/unsupported/);
  });

  it('rejects an invalid option pair when the factory is created, not when it is applied', () => {
    expect(() => node({parallelWorker: false, maxParallelWorkers: 2})).toThrow(
      'maxParallelWorkers can only be set when parallelWorker is true.',
    );
  });

  it('rejects a fan-out over the START sentinel', () => {
    expect(() => node({parallelWorker: true})('START')).toThrow(
      'ParallelWorker cannot wrap a START node.',
    );
  });
});

describe('WorkflowNode parallel worker', () => {
  it('forces rerunOnResume to the value ParallelWorker sets on itself', () => {
    const fanning = new TaggedNode({
      name: 'fan',
      tag: 't',
      parallelWorker: true,
      rerunOnResume: false,
    });
    expect(fanning.rerunOnResume).toBe(new ParallelWorker(greet).rerunOnResume);
    expect(fanning.rerunOnResume).toBe(true);
  });

  it('leaves rerunOnResume alone without parallelWorker', () => {
    const plain = new TaggedNode({name: 'plain', tag: 't'});
    expect(plain.rerunOnResume).toBe(false);
  });

  it('builds the wrapper late enough to see fields the subclass constructor set', async () => {
    // An eagerly built wrapper would carry a copy whose `tag` is still
    // undefined, because `super()` runs before the subclass assigns it.
    const fanning = new TaggedNode({
      name: 'fan',
      tag: 'late',
      parallelWorker: true,
    });
    const {output} = await driveNode(fanning, ['a', 'b']);
    expect(output).toEqual(['late/fan: a', 'late/fan: b']);
  });

  it('dispatches to runNodeImpl when parallelWorker is off', async () => {
    const plain = new TaggedNode({name: 'plain', tag: 'x'});
    const {output} = await driveNode(plain, 'one');
    expect(output).toBe('x/plain: one');
  });

  it('fans a copy out over itself, not over the node it was copied from', async () => {
    const original = new TaggedNode({
      name: 'original',
      tag: 'shared',
      parallelWorker: true,
    });
    // Run the original first so it memoises a wrapper around itself; the copy
    // must not inherit it.
    expect((await driveNode(original, ['x'])).output).toEqual([
      'shared/original: x',
    ]);

    const renamed = node(original, {name: 'renamed'});
    const {output} = await driveNode(renamed, ['x', 'y']);
    expect(output).toEqual(['shared/renamed: x', 'shared/renamed: y']);
  });

  it('reuses one wrapper across runs of the same node', async () => {
    const fanning = new TaggedNode({
      name: 'fan',
      tag: 'memo',
      parallelWorker: true,
    });
    expect((await driveNode(fanning, ['a'])).output).toEqual(['memo/fan: a']);
    expect((await driveNode(fanning, ['b'])).output).toEqual(['memo/fan: b']);
  });

  it('throws when no wrapper could be built', async () => {
    const workerless = new WorkerlessNode({
      name: 'workerless',
      tag: 'none',
      parallelWorker: true,
    });
    await expect(driveNode(workerless, ['a'])).rejects.toThrow(
      'inner_node is not initialized for parallel worker.',
    );
  });

  it('bounds the fan-out by maxParallelWorkers', async () => {
    let active = 0;
    let peak = 0;

    class TrackingNode extends WorkflowNode<number, number> {
      protected async *runNodeImpl(_ctx: NodeContext, input: number) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        yield input;
      }
    }

    const tracking = new TrackingNode({
      name: 'tracking',
      parallelWorker: true,
      maxParallelWorkers: 2,
    });
    const {output} = await driveNode(tracking, [1, 2, 3, 4, 5]);
    expect(output).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('fans out inside a workflow, behind a producer', async () => {
    const fanning = new TaggedNode({
      name: 'fan',
      tag: 'wf',
      parallelWorker: true,
    });
    const wf = new Workflow({
      name: 'fan_wf',
      edges: [['START', node(producePair), fanning]],
    });
    expect((await driveNode(wf)).output).toEqual(['wf/fan: p', 'wf/fan: q']);
  });
});

describe('isWorkflowNode', () => {
  it('matches a WorkflowNode and its copies, and nothing else', () => {
    const fanning = new TaggedNode({name: 'fan', tag: 't'});
    expect(isWorkflowNode(fanning)).toBe(true);
    expect(isWorkflowNode(fanning.clone())).toBe(true);
    expect(isWorkflowNode(new FunctionNode('plain', greet))).toBe(false);
    expect(isWorkflowNode(null)).toBe(false);
    expect(isWorkflowNode({name: 'fan'})).toBe(false);
  });
});

function producePair() {
  return ['p', 'q'];
}
