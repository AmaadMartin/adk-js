/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Parity tests for the workflow half of `google/adk-python`
 * `src/google/adk/agents/context.py::Context`, which adk-js keeps in
 * `NodeContext`. The callback and tool half is covered by
 * `core/test/agents/context_python_parity_test.ts`.
 */

import {createEvent, Event} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {AsyncQueue} from '../../src/utils/async_queue.js';
import {isNodeInterruptedError} from '../../src/workflow/errors.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {createIc, driveNode, driveWorkflow, FnNode} from './test_helpers.js';

/** A root context with no owning node, as the runner builds for an entrypoint. */
function rootContext(): NodeContext {
  return new NodeContext({
    invocationContext: createIc(),
    channel: new AsyncQueue<Event>(),
    nodePath: '',
    runId: 'root',
  });
}

describe('NodeContext — parent chain', () => {
  it('sets parentCtx and node on a child produced by runNode', async () => {
    const child = new FnNode('child', () => 'done');
    let seen: NodeContext | undefined;
    const parent = new FnNode('parent', async (ctx, input) => {
      const result = await ctx.runNode(child, input);
      seen = result as NodeContext;
      return 'ok';
    });

    const {ctx: root} = await driveNode(parent, 'x');

    expect(seen).toBeDefined();
    expect(seen?.node).toBe(child);
    expect(seen?.parentCtx?.node).toBe(parent);
    expect(seen?.parentCtx?.parentCtx).toBe(root);
  });

  it('leaves parentCtx and node unset on a root context', () => {
    const root = rootContext();

    expect(root.parentCtx).toBeUndefined();
    expect(root.node).toBeUndefined();
  });

  it('inherits the parent scheduler onto a child context', async () => {
    let childScheduler: unknown;
    const child = new FunctionNode('child', (ctx) => {
      childScheduler = ctx.scheduler;
      return 'done';
    });
    const wf = new Workflow({
      name: 'wf',
      dynamicEntry: async (ctx, input) => {
        expect(ctx.scheduler).toBeDefined();
        await ctx.runNode(child, input);
        return 'ok';
      },
    });

    await driveWorkflow(wf, 'x');

    expect(childScheduler).toBeDefined();
  });
});

describe('NodeContext — error and errorNodePath', () => {
  it('records the failure on the child context, and still throws', async () => {
    let failedCtx: NodeContext | undefined;
    let caught: unknown;
    const boom = new FnNode('boom', (ctx) => {
      failedCtx = ctx;
      throw new Error('kaboom');
    });
    const parent = new FnNode('parent', async (ctx, input) => {
      caught = await ctx.runNode(boom, input).then(
        () => undefined,
        (err: unknown) => err,
      );
      return 'ok';
    });

    await driveNode(parent, 'x');

    expect((caught as Error).message).toBe('kaboom');
    expect(failedCtx?.error?.message).toBe('kaboom');
    expect(failedCtx?.errorNodePath).toBe('parent.boom');
  });

  it('keeps the originating node path when a dynamic child fails', async () => {
    let midCtx: NodeContext | undefined;
    const boom = new FunctionNode('boom', () => {
      throw new Error('kaboom');
    });
    const mid = new FunctionNode('mid', async (ctx, input) => {
      midCtx = ctx;
      await ctx.runNode(boom, input);
      return 'unreachable';
    });
    const wf = new Workflow({
      name: 'wf',
      dynamicEntry: async (ctx, input) => {
        await ctx.runNode(mid, input).catch(() => undefined);
        return 'ok';
      },
    });

    await driveWorkflow(wf, 'x');

    expect(midCtx?.errorNodePath).toBe('wf.mid@1.boom@1');
  });

  it('leaves error unset when the node succeeds', async () => {
    const {ctx} = await driveNode(new FnNode('fine', () => 'ok'), 'x');

    expect(ctx.error).toBeUndefined();
    expect(ctx.errorNodePath).toBe('');
  });

  it('wraps a thrown non-Error value so error is always an Error', async () => {
    let failedCtx: NodeContext | undefined;
    const boom = new FnNode('boom', (ctx) => {
      failedCtx = ctx;
      throw 'a bare string';
    });
    const parent = new FnNode('parent', async (ctx, input) => {
      await ctx.runNode(boom, input).catch(() => undefined);
      return 'ok';
    });

    await driveNode(parent, 'x');

    expect(failedCtx?.error).toBeInstanceOf(Error);
    expect(failedCtx?.error?.message).toBe('a bare string');
  });
});

/**
 * The runner only chooses an author for an event that carries none — a node
 * yielding a raw value gets `author: node.name` when `BaseNode.toEvent` boxes
 * it, well before the runner sees it. So these tests yield author-less events,
 * which is what an interrupt (`createRequestInputEvent`) and a hand-built event
 * look like.
 */
describe('NodeContext — eventAuthor', () => {
  it('authors an event with the node name when eventAuthor is empty', async () => {
    const worker = new FnNode('worker', () => createEvent({output: 'ok'}));

    const {events, ctx} = await driveNode(worker, 'x');

    expect(ctx.eventAuthor).toBe('');
    expect(events[0].author).toBe('worker');
  });

  it('authors an event with eventAuthor when the orchestrator sets one', async () => {
    const worker = new FnNode('worker', (ctx) => {
      ctx.eventAuthor = 'supervisor';
      return createEvent({output: 'ok'});
    });

    const {events} = await driveNode(worker, 'x');

    expect(events[0].author).toBe('supervisor');
  });

  it('does not override an author the node set itself', async () => {
    const worker = new FnNode('worker', (ctx) => {
      ctx.eventAuthor = 'supervisor';
      return createEvent({author: 'mine', output: 'ok'});
    });

    const {events} = await driveNode(worker, 'x');

    expect(events[0].author).toBe('mine');
  });

  it('inherits eventAuthor from the parent context', async () => {
    let childAuthor: string | undefined;
    const child = new FnNode('child', (ctx) => {
      childAuthor = ctx.eventAuthor;
      return createEvent({output: 'done'});
    });
    const parent = new FnNode('parent', async (ctx, input) => {
      ctx.eventAuthor = 'supervisor';
      await ctx.runNode(child, input);
      return createEvent({output: 'ok'});
    });

    const {events} = await driveNode(parent, 'x');

    expect(childAuthor).toBe('supervisor');
    expect(events.map((event) => event.author)).toEqual([
      'supervisor',
      'supervisor',
    ]);
  });
});

describe('NodeContext — telemetryContext', () => {
  it('captures an otel context when the node context is built', () => {
    const root = rootContext();

    expect(root.telemetryContext).toBeDefined();
    expect(root.telemetryContext.otelContext).toBeDefined();
    expect(root.telemetryContext.associatedEventIds).toEqual([]);
  });

  it('accumulates the ids of the events the node emitted', async () => {
    let nodeCtx: NodeContext | undefined;
    const worker = new FnNode('worker', (ctx) => {
      nodeCtx = ctx;
      ctx.emit(
        createEvent({author: 'worker', content: {parts: [{text: 'a'}]}}),
      );
      return 'ok';
    });

    const {events} = await driveNode(worker, 'x');

    // `emit` pushes straight to the channel, so only the yielded output event
    // goes through the runner's tracking seam.
    expect(nodeCtx?.telemetryContext.associatedEventIds).toEqual([
      events[1].id,
    ]);
  });
});

describe('NodeContext — single output', () => {
  it('refuses a second assignment to ctx.output', async () => {
    const greedy = new FnNode('greedy', (ctx) => {
      ctx.output = 'first';
      ctx.output = 'second';
      return undefined;
    });

    await expect(driveNode(greedy, 'x')).rejects.toThrowError(
      'Output already set. A node can produce at most one output.',
    );
  });

  it('accepts a single assignment to ctx.output', async () => {
    let nodeCtx: NodeContext | undefined;
    const tidy = new FnNode('tidy', (ctx) => {
      nodeCtx = ctx;
      ctx.output = 'only';
      return undefined;
    });

    await driveNode(tidy, 'x');

    expect(nodeCtx?.output).toBe('only');
  });

  it('clears the output between retry attempts', async () => {
    let attempts = 0;
    const flaky = new FnNode(
      'flaky',
      (ctx) => {
        attempts++;
        ctx.output = `attempt-${attempts}`;
        if (attempts < 2) {
          throw new Error('transient');
        }
        return undefined;
      },
      {retryConfig: {maxAttempts: 2, initialDelay: 0, jitter: 0}},
    );

    const {output} = await driveNode(flaky, 'x');

    expect(attempts).toBe(2);
    expect(output).toBe('attempt-2');
  });
});

describe('NodeContext — use_as_output delegation', () => {
  it('refuses a second useAsOutput child', async () => {
    const first = new FnNode('first', () => 'a');
    const second = new FnNode('second', () => 'b');
    const parent = new FnNode('parent', async (ctx, input) => {
      await ctx.runNode(first, input, {useAsOutput: true});
      await ctx.runNode(second, input, {useAsOutput: true});
      return undefined;
    });

    await expect(driveNode(parent, 'x')).rejects.toThrowError(
      'Node parent already has a use_as_output delegate.',
    );
  });

  it('allows one useAsOutput child', async () => {
    const only = new FnNode('only', () => 'a');
    const parent = new FnNode('parent', async (ctx, input) => {
      await ctx.runNode(only, input, {useAsOutput: true});
      return undefined;
    });

    expect((await driveNode(parent, 'x')).output).toBe('a');
  });

  it('exempts a Workflow, which delegates on behalf of its terminal node', async () => {
    const first = new FunctionNode('first', () => 'a');
    const second = new FunctionNode('second', () => 'b');
    const wf = new Workflow({
      name: 'wf',
      dynamicEntry: async (ctx, input) => {
        await ctx.runNode(first, input, {useAsOutput: true});
        await ctx.runNode(second, input, {useAsOutput: true});
        return undefined;
      },
    });

    expect((await driveWorkflow(wf, 'x')).output).toBe('b');
  });
});

describe('NodeContext — raiseOnWait', () => {
  it('raises when a waitForOutput child produces nothing', async () => {
    const waiter = new FnNode('waiter', () => undefined, {
      waitForOutput: true,
    });
    let raised: unknown;
    const parent = new FnNode('parent', async (ctx, input) => {
      try {
        await ctx.runNode(waiter, input, {raiseOnWait: true});
      } catch (err) {
        raised = err;
      }
      return 'ok';
    });

    await driveNode(parent, 'x');

    expect(isNodeInterruptedError(raised)).toBe(true);
  });

  it('raises when a Workflow child produces nothing', async () => {
    const inner = new Workflow({
      name: 'inner',
      dynamicEntry: async () => undefined,
    });
    let raised: unknown;
    const parent = new FnNode('parent', async (ctx, input) => {
      try {
        await ctx.runNode(inner, input, {raiseOnWait: true});
      } catch (err) {
        raised = err;
      }
      return 'ok';
    });

    await driveNode(parent, 'x');

    expect(isNodeInterruptedError(raised)).toBe(true);
  });

  it('returns normally when the waiting child did produce an output', async () => {
    const waiter = new FnNode('waiter', () => 'answered', {
      waitForOutput: true,
    });
    let childOutput: unknown;
    const parent = new FnNode('parent', async (ctx, input) => {
      const child = await ctx.runNode(waiter, input, {raiseOnWait: true});
      childOutput = child.output;
      return 'ok';
    });

    await driveNode(parent, 'x');

    expect(childOutput).toBe('answered');
  });

  it('returns an empty-output ordinary child, which is not waiting', async () => {
    const quiet = new FnNode('quiet', () => undefined);
    let childOutput: unknown = 'UNSET';
    const parent = new FnNode('parent', async (ctx, input) => {
      const child = await ctx.runNode(quiet, input, {raiseOnWait: true});
      childOutput = child.output;
      return 'ok';
    });

    await driveNode(parent, 'x');

    expect(childOutput).toBeUndefined();
  });

  it('returns an empty-output waiting child when raiseOnWait is not set', async () => {
    const waiter = new FnNode('waiter', () => undefined, {
      waitForOutput: true,
    });
    let childOutput: unknown = 'UNSET';
    const parent = new FnNode('parent', async (ctx, input) => {
      const child = await ctx.runNode(waiter, input);
      childOutput = child.output;
      return 'ok';
    });

    await driveNode(parent, 'x');

    expect(childOutput).toBeUndefined();
  });
});

describe('NodeContext — getInvocationContext and runNode result', () => {
  /**
   * Ports `test_get_invocation_context_propagates_isolation_scope`. adk-js
   * diverges deliberately: the runner has already built the child invocation
   * context with the node's isolation scope, so this returns that context
   * rather than copying it (see the doc comment on `getInvocationContext`).
   */
  it('test_get_invocation_context_propagates_isolation_scope', async () => {
    let seenScope: string | undefined;
    let seenIc = false;
    const scoped = new FnNode(
      'scoped',
      (ctx) => {
        const ic = ctx.getInvocationContext();
        seenIc = ic === ctx.invocationContext;
        seenScope = ic.isolationScope;
        return 'ok';
      },
      {isolationScope: 'test-isolation-scope'},
    );

    await driveNode(scoped, 'x');

    expect(seenIc).toBe(true);
    expect(seenScope).toBe('test-isolation-scope');
  });

  /** Ports `test_run_node_internal_returns_ctx_and_handles_resume_inputs`. */
  it('test_run_node_internal_returns_ctx_and_handles_resume_inputs', async () => {
    let childResumeInputs: Record<string, unknown> | undefined;
    const child = new FnNode('child', (ctx) => {
      childResumeInputs = ctx.resumeInputs;
      return 'a_output';
    });
    let childCtx: NodeContext | undefined;
    const parent = new FnNode('parent', async (ctx, input) => {
      childCtx = (await ctx.runNode(child, input)) as NodeContext;
      return 'ok';
    });

    const channel = new AsyncQueue<Event>();
    const root = new NodeContext({
      invocationContext: createIc(),
      channel,
      nodePath: '',
      runId: 'root',
      resumeInputs: {some_key: 'some_val'},
    });
    const settle = root.runNode(parent, 'a_input').then(
      () => channel.close(),
      (err: unknown) => channel.fail(err),
    );
    for await (const _event of channel) {
      // Drain so the node run can finish.
    }
    await settle;

    expect(childCtx?.output).toBe('a_output');
    expect(childResumeInputs).toEqual({some_key: 'some_val'});
  });
});
