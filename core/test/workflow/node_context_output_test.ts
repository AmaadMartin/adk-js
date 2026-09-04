/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `ctx.output` contract and the `runNode` guards around it: at most one
 * output per run, at most one `useAsOutput` delegate, and `raiseOnWait` for a
 * child that finishes while it still waits for output. adk-python pins the same
 * rules through `Context.output` (`agents/context.py`) and
 * `Context._run_node_internal`.
 */

import {beforeEach, describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {isNodeInterruptedError} from '../../src/workflow/errors.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc, driveWorkflow, FnNode} from './test_helpers.js';

let ic: InvocationContext;
let channel: AsyncQueue<Event>;

beforeEach(() => {
  ic = createIc();
  channel = new AsyncQueue<Event>();
});

function rootCtx(): NodeContext {
  return new NodeContext({
    invocationContext: ic,
    channel,
    nodePath: '',
    runId: '1',
  });
}

describe('NodeContext.output', () => {
  it('refuses a second output and keeps the first', async () => {
    let readBack: unknown;
    const twice = new FnNode('twice', (ctx) => {
      ctx.output = 'first';
      try {
        ctx.output = 'second';
      } finally {
        readBack = ctx.output;
      }
    });

    await expect(rootCtx().runNode(twice)).rejects.toThrow(
      'Output already set. A node can produce at most one output.',
    );
    expect(readBack).toBe('first');
  });

  it('lets a retried attempt set the output again', async () => {
    let attempts = 0;
    const flaky = new FnNode(
      'flaky',
      (ctx) => {
        attempts += 1;
        ctx.output = `attempt-${attempts}`;
        if (attempts === 1) {
          throw new Error('boom');
        }
      },
      {retryConfig: {maxAttempts: 2}},
    );

    const child = await rootCtx().runNode(flaky);

    expect(attempts).toBe(2);
    expect(child.output).toBe('attempt-2');
  });

  it('lets a parent adopt a child output it already produced itself', async () => {
    // The engine writes the parent's output directly under `useAsOutput`, so a
    // parent that also set its own output is not refused.
    const child = new FnNode('child', (ctx) => {
      ctx.output = 'from-child';
    });
    const parent = new FnNode('parent', async (ctx) => {
      ctx.output = 'from-parent';
      await ctx.runNode(child, undefined, {useAsOutput: true});
    });

    const result = await rootCtx().runNode(parent);

    expect(result.output).toBe('from-child');
  });
});

describe('runNode useAsOutput delegation', () => {
  it('refuses a second delegate from the same node', async () => {
    const first = new FnNode('first', (ctx) => {
      ctx.output = 'one';
    });
    const second = new FnNode('second', (ctx) => {
      ctx.output = 'two';
    });
    const caller = new FnNode('caller', async (ctx) => {
      await ctx.runNode(first, undefined, {useAsOutput: true});
      await ctx.runNode(second, undefined, {useAsOutput: true});
    });

    await expect(rootCtx().runNode(caller)).rejects.toThrow(
      'already has a use_as_output delegate.',
    );
  });

  it('claims the delegate before the child runs, so a failed child still counts', async () => {
    const boom = new FnNode('boom', () => {
      throw new Error('child failed');
    });
    let delegatedAfterFailure: boolean | undefined;
    const caller = new FnNode('caller', async (ctx) => {
      await ctx.runNode(boom, undefined, {useAsOutput: true}).catch(() => {});
      delegatedAfterFailure = ctx.outputDelegated;
    });

    await rootCtx().runNode(caller);

    expect(delegatedAfterFailure).toBe(true);
  });

  it('lets a workflow delegate to each of its nodes in turn', async () => {
    const one = new FunctionNode('one', () => 'one');
    const two = new FunctionNode('two', () => 'two');
    const wf = new Workflow({
      name: 'wf',
      edges: [
        ['START', one],
        [one, two],
      ],
    });

    expect((await driveWorkflow(wf)).output).toBe('two');
  });
});

describe('runNode raiseOnWait', () => {
  /** A node that declares it waits for output and then produces `value`. */
  function waiter(value?: unknown): FnNode {
    return new FnNode(
      'waiter',
      (ctx) => {
        if (value !== undefined) {
          ctx.output = value;
        }
      },
      {waitForOutput: true},
    );
  }

  it('stops the caller body at a waiting child that produced no output', async () => {
    let raised: unknown;
    let reachedEnd = false;
    const caller = new FnNode('caller', async (ctx) => {
      try {
        await ctx.runNode(waiter(), undefined, {raiseOnWait: true});
      } catch (err) {
        raised = err;
        throw err;
      }
      reachedEnd = true;
    });

    const result = await rootCtx().runNode(caller);

    expect(isNodeInterruptedError(raised)).toBe(true);
    expect(reachedEnd).toBe(false);
    // The caller is left with no result, so the workflow records it as waiting
    // rather than completing it on a value the child never produced.
    expect(result.output).toBeUndefined();
  });

  it('does not raise when the waiting child produced output', async () => {
    const caller = new FnNode('caller', async (ctx) => {
      const child = await ctx.runNode(waiter('ready'), undefined, {
        raiseOnWait: true,
      });
      ctx.output = child.output;
    });

    expect((await rootCtx().runNode(caller)).output).toBe('ready');
  });

  it('does not raise for a child that does not wait for output', async () => {
    const quiet = new FnNode('quiet', () => undefined);
    const caller = new FnNode('caller', async (ctx) => {
      await ctx.runNode(quiet, undefined, {raiseOnWait: true});
      ctx.output = 'caller-finished';
    });

    expect((await rootCtx().runNode(caller)).output).toBe('caller-finished');
  });

  it('stops the caller body at a nested workflow that produced no output', async () => {
    const noop = new FunctionNode('noop', () => undefined);
    const inner = new Workflow({name: 'inner', edges: [['START', noop]]});
    let reachedEnd = false;
    const caller = new FnNode('caller', async (ctx) => {
      await ctx.runNode(inner, undefined, {raiseOnWait: true});
      reachedEnd = true;
    });

    await rootCtx().runNode(caller);

    expect(reachedEnd).toBe(false);
  });

  it('is off by default, so a waiting child just returns', async () => {
    const caller = new FnNode('caller', async (ctx) => {
      const child = await ctx.runNode(waiter());
      ctx.output = child.output === undefined ? 'nothing' : 'something';
    });

    expect((await rootCtx().runNode(caller)).output).toBe('nothing');
  });
});
