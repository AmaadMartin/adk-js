/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A node started with `ctx.runNode()` that the caller never awaits — a detached
 * "fire and forget" run — bypasses the normal completion path. The workflow
 * awaits whatever is still in flight when the graph finishes and reports a bad
 * outcome instead of succeeding quietly.
 *
 * Ported from `google/adk-python`
 * `tests/unittests/workflow/test_workflow_dynamic_nodes.py` at `25f5214c`.
 */

import {describe, expect, it} from 'vitest';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {driveWorkflow} from './test_helpers.js';

/** Resolves after the current macrotask, letting a detached run start. */
const yieldToScheduler = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A child that takes a moment, so it is still in flight when the graph ends. */
const slowChild = (body: () => unknown) =>
  new FunctionNode('child', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return body();
  });

/**
 * Starts `child` without awaiting it. The returned promise is given a no-op
 * rejection handler so Node does not report it as unhandled; the workflow reads
 * the outcome from the run itself, not from this promise.
 */
function detach(ctx: NodeContext, child: FunctionNode): void {
  void ctx.runNode(child, 'go').catch(() => {});
}

describe('detached dynamic nodes', () => {
  it('test_detached_dynamic_node_failure_surfaces', async () => {
    const child = slowChild(() => {
      throw new Error('detached boom');
    });
    const parent = new FunctionNode(
      'parent',
      async (ctx) => {
        detach(ctx, child);
        await yieldToScheduler();
        return 'parent done';
      },
      {rerunOnResume: true},
    );
    const wf = new Workflow({name: 'wf', edges: [['START', parent]]});

    await expect(driveWorkflow(wf, 'go')).rejects.toThrow(/detached boom/);
  });

  it('test_detached_dynamic_node_interrupt_surfaces', async () => {
    const child = slowChild(() => new RequestInput({interruptId: 'fc-det'}));
    const parent = new FunctionNode(
      'parent',
      async (ctx) => {
        detach(ctx, child);
        await yieldToScheduler();
        return 'parent done';
      },
      {rerunOnResume: true},
    );
    const wf = new Workflow({name: 'wf', edges: [['START', parent]]});

    await expect(driveWorkflow(wf, 'go')).rejects.toThrow(
      /detached node cannot be resumed/,
    );
  });

  it('test_detached_dynamic_node_success_keeps_workflow_succeeding', async () => {
    const child = slowChild(() => 'child done');
    const parent = new FunctionNode(
      'parent',
      async (ctx) => {
        detach(ctx, child);
        await yieldToScheduler();
        return 'parent done';
      },
      {rerunOnResume: true},
    );
    const wf = new Workflow({name: 'wf', edges: [['START', parent]]});

    expect((await driveWorkflow(wf, 'go')).output).toBe('parent done');
  });

  it('test_detached_dynamic_node_finished_before_graph_end_is_not_checked', async () => {
    // Known limit: a settled run cannot be told apart from an awaited, handled
    // one, so its failure stays swallowed. Pinned so the boundary does not move
    // by accident.
    const child = new FunctionNode('child', () => {
      throw new Error('early boom');
    });
    const parent = new FunctionNode(
      'parent',
      async (ctx) => {
        await ctx.runNode(child, 'go').catch(() => {});
        return 'parent done';
      },
      {rerunOnResume: true},
    );
    const wf = new Workflow({name: 'wf', edges: [['START', parent]]});

    expect((await driveWorkflow(wf, 'go')).output).toBe('parent done');
  });
});
