/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python` `main`,
 * `tests/unittests/agents/test_context.py` — the classes covering the workflow
 * half of `Context` that adk-js keeps on `NodeContext`:
 * `TestContextGetInvocationContext`, `TestContextRunNodeInternal` and
 * `TestDeriveScheduler`. The ported cases keep their Python names verbatim so a
 * reviewer can grep across the two repositories; each carries a note where
 * adk-js reaches the same guarantee by a different route.
 */

import {beforeEach, describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {Event} from '../../src/events/event.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc, driveWorkflow} from './test_helpers.js';

let ic: InvocationContext;
let channel: AsyncQueue<Event>;

beforeEach(() => {
  ic = createIc();
  channel = new AsyncQueue<Event>();
});

describe('NodeContext.getInvocationContext', () => {
  it('test_get_invocation_context_propagates_isolation_scope', async () => {
    // adk-python copies the invocation context with the proxy session and the
    // isolation scope. adk-js hands back the node's own invocation context: the
    // node runner already built it with the node's scope, so the scope is on
    // the object returned rather than applied by a copy here.
    const seen: Array<string | undefined> = [];
    const inner = new FunctionNode('inner', (ctx) => {
      seen.push(ctx.getInvocationContext().isolationScope);
      return 'done';
    });
    const scoped = new FunctionNode(
      'scoped',
      (ctx) => ctx.runNode(inner).then((child) => child.output),
      {isolationScope: 'test-isolation-scope'},
    );

    const result = await driveWorkflow(
      new Workflow({name: 'wf', edges: [['START', scoped]]}),
    );

    expect(result.output).toBe('done');
    expect(seen).toEqual(['test-isolation-scope']);
  });

  it('hands back the very same invocation context object', () => {
    const ctx = new NodeContext({
      invocationContext: ic,
      channel,
      nodePath: '',
      runId: '1',
    });

    expect(ctx.getInvocationContext()).toBe(ic);
  });
});

describe('NodeContext.runNode internals', () => {
  it('test_run_node_internal_returns_ctx_and_handles_resume_inputs', async () => {
    // adk-python's `run_node` resolves to the child's output and only
    // `_run_node_internal(return_ctx=True)` resolves to the context. adk-js has
    // one method and always resolves to the context.
    const seen: Array<Record<string, unknown>> = [];
    const agentA = new FunctionNode('agent_a', (ctx) => {
      seen.push({...ctx.resumeInputs});
      return 'a_output';
    });
    const root = new NodeContext({
      invocationContext: ic,
      channel,
      nodePath: '',
      runId: '1',
      resumeInputs: {some_key: 'some_val'},
    });

    const child = await root.runNode(agentA, 'a_input');

    expect(child).toBeInstanceOf(NodeContext);
    expect(child.output).toBe('a_output');
    expect(seen).toEqual([{some_key: 'some_val'}]);
  });
});

describe('scheduler derivation', () => {
  // adk-python derives the scheduler in a `_derive_scheduler` free function
  // called from `Context.__init__`; adk-js propagates it in `runChildNode`
  // (`node_runner.ts`), so these assert the propagation rather than the
  // function.

  it('test_derive_scheduler_no_parent', () => {
    const root = new NodeContext({
      invocationContext: ic,
      channel,
      nodePath: '',
      runId: '1',
    });

    expect(root.scheduler).toBeUndefined();
  });

  it('test_derive_scheduler_with_parent_having_scheduler', async () => {
    const seen: Array<unknown> = [];
    const inner = new FunctionNode('inner', (ctx) => {
      seen.push(ctx.scheduler);
      return 'ok';
    });
    const outer = new FunctionNode('outer', async (ctx) => {
      seen.push(ctx.scheduler);
      await ctx.runNode(inner);
      return 'ok';
    });

    await driveWorkflow(new Workflow({name: 'wf', edges: [['START', outer]]}));

    // The workflow installs one scheduler and every descendant inherits it.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBe(seen[0]);
  });

  it('test_derive_scheduler_with_parent_no_scheduler', async () => {
    // Outside a workflow there is no scheduler to inherit, and adk-js does not
    // invent one: `ctx.runNode` runs the child directly instead.
    const seen: Array<unknown> = [];
    const inner = new FunctionNode('inner', (ctx) => {
      seen.push(ctx.scheduler);
      return 'ok';
    });
    const root = new NodeContext({
      invocationContext: ic,
      channel,
      nodePath: '',
      runId: '1',
    });

    const child = await root.runNode(inner);

    expect(child.output).toBe('ok');
    expect(seen).toEqual([undefined]);
  });

  it('gives a nested workflow its own scheduler', async () => {
    const seen: Array<unknown> = [];
    const leaf = new FunctionNode('leaf', (ctx) => {
      seen.push(ctx.scheduler);
      return 'leaf';
    });
    const innerWf = new Workflow({name: 'inner', edges: [['START', leaf]]});
    const outerLeaf = new FunctionNode('outer_leaf', (ctx) => {
      seen.push(ctx.scheduler);
      return 'outer_leaf';
    });

    await driveWorkflow(
      new Workflow({
        name: 'outer',
        edges: [
          ['START', outerLeaf],
          [outerLeaf, innerWf],
        ],
      }),
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).not.toBe(seen[0]);
  });
});
