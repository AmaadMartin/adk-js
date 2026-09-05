/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-js-specific half of the `node.ts` parallel-worker tests: the lazy
 * wrapper, the eager option validation on the factory form, and the copy that
 * has to rebuild its wrapper. The tests ported from adk-python live in
 * `workflow_node_test.ts`.
 */

import {
  BaseNode,
  FunctionNode,
  node,
  NodeContext,
  Workflow,
  WorkflowNode,
  WorkflowNodeConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {driveNode, driveWorkflow} from './test_helpers.js';

/** Counters shared by a node and every shallow copy of it. */
interface Counters {
  active: number;
  peak: number;
  built: number;
}

function newCounters(): Counters {
  return {active: 0, peak: 0, built: 0};
}

/** Configuration for the nodes below, all of which share {@link Counters}. */
interface CountingNodeConfig extends WorkflowNodeConfig {
  counters: Counters;
}

/** A node that reports its own name, so a stale wrapper is visible. */
class NamingNode extends WorkflowNode<string, string> {
  protected async *runNodeImpl(_ctx: NodeContext, input: string) {
    yield `${this.name}: ${input}`;
  }
}

/** A node that records how wide its fan-out ran, and how often it was built. */
class CountingNode extends WorkflowNode<number, number> {
  private readonly counters: Counters;

  constructor(config: CountingNodeConfig) {
    super(config);
    this.counters = config.counters;
  }

  protected override createParallelWorker(): BaseNode {
    this.counters.built++;
    return super.createParallelWorker();
  }

  protected async *runNodeImpl(_ctx: NodeContext, input: number) {
    this.counters.active++;
    this.counters.peak = Math.max(this.counters.peak, this.counters.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.counters.active--;
    yield input;
  }
}

describe('WorkflowNode — parallel worker', () => {
  it('sets rerunOnResume before the node runs', () => {
    // The engine reads the flag when it schedules the node, which is before
    // the wrapper that forces it exists.
    expect(
      new NamingNode({name: 'eager', parallelWorker: true}).rerunOnResume,
    ).toBe(true);
    expect(new NamingNode({name: 'plain'}).rerunOnResume).toBe(false);
  });

  it('bounds the fan-out with maxParallelWorkers', async () => {
    const counters = newCounters();
    const bounded = new CountingNode({
      name: 'bounded',
      parallelWorker: true,
      maxParallelWorkers: 2,
      counters,
    });

    const wf = new Workflow({name: 'bounded_wf', edges: [['START', bounded]]});
    const {output} = await driveWorkflow(wf, [1, 2, 3, 4, 5, 6]);

    expect(output).toEqual([1, 2, 3, 4, 5, 6]);
    expect(counters.peak).toBeGreaterThan(1);
    expect(counters.peak).toBeLessThanOrEqual(2);
  });

  it('builds the fan-out wrapper once and reuses it', async () => {
    const counters = newCounters();
    const reused = new CountingNode({
      name: 'reused',
      parallelWorker: true,
      counters,
    });
    const wf = new Workflow({name: 'reuse_wf', edges: [['START', reused]]});

    expect((await driveWorkflow(wf, [1])).output).toEqual([1]);
    expect((await driveWorkflow(wf, [2])).output).toEqual([2]);
    expect(counters.built).toBe(1);
  });
});

describe('node() — the factory form', () => {
  it('returns a wrapper when it is given no arguments', () => {
    const wrap = node();

    const built = wrap(function bare() {
      return 1;
    });

    expect(built).toBeInstanceOf(FunctionNode);
    expect(built.name).toBe('bare');
  });

  it('rejects an impossible option pair before the wrapper is applied', () => {
    // adk-python raises when the decorator factory is created, so the call
    // that got it wrong is the one that throws.
    expect(() => node({maxParallelWorkers: 2})).toThrow(
      'maxParallelWorkers can only be set when parallelWorker is true.',
    );
  });
});

describe('node() — copying a node', () => {
  it('rebuilds the inner worker of a WorkflowNode copy', async () => {
    const original = new NamingNode({name: 'original', parallelWorker: true});
    // Run the original first, so its wrapper exists to be copied. A copy taken
    // before that builds a correct wrapper of its own and hides the fault.
    const first = await driveWorkflow(
      new Workflow({name: 'first_wf', edges: [['START', original]]}),
      ['x'],
    );
    expect(first.output).toEqual(['original: x']);

    const renamed = node(original, {name: 'renamed'});
    const second = await driveWorkflow(
      new Workflow({name: 'second_wf', edges: [['START', renamed]]}),
      ['x'],
    );

    // A stale wrapper would fan out over the original and emit 'original: x'.
    expect(second.output).toEqual(['renamed: x']);
  });

  it('leaves a copy that is not a WorkflowNode alone', async () => {
    const original = new FunctionNode('fn', (_ctx, input) => `echo:${input}`);

    const copy = node(original, {name: 'copied'});

    expect(copy).toBeInstanceOf(FunctionNode);
    expect(copy.name).toBe('copied');
    expect((await driveNode(copy, 'hi')).output).toBe('echo:hi');
  });
});
