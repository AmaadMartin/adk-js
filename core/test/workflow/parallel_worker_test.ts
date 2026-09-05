/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {logger} from '../../src/utils/logger.js';
import {START} from '../../src/workflow/base_node.js';
import {NodeTimeoutError} from '../../src/workflow/errors.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {FunctionNode} from '../../src/workflow/nodes/function_node.js';
import {JoinNode} from '../../src/workflow/nodes/join_node.js';
import {ParallelWorker} from '../../src/workflow/nodes/parallel_worker.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {hasRequestInputFunctionCall} from '../../src/workflow/utils/hitl_utils.js';
import {buildNode} from '../../src/workflow/utils/workflow_graph_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';
import {
  createIc,
  driveNode,
  driveWorkflow,
  replyAgent,
} from './test_helpers.js';

describe('ParallelWorker', () => {
  it('maps a list input through the inner node, preserving order', async () => {
    const inner = new FunctionNode('double', (_c, n: number) => n * 2);
    const {output} = await driveNode(new ParallelWorker(inner), [1, 2, 3, 4]);
    expect(output).toEqual([2, 4, 6, 8]);
  });

  it('treats a non-list input as a single-element list', async () => {
    const inner = new FunctionNode('double', (_c, n: number) => n * 2);
    const {output} = await driveNode(new ParallelWorker(inner), 5);
    expect(output).toEqual([10]);
  });

  it('yields an empty list for an empty input', async () => {
    const inner = new FunctionNode('id', (_c, x) => x);
    const {output} = await driveNode(new ParallelWorker(inner), []);
    expect(output).toEqual([]);
  });

  it('bounds concurrency by maxParallelWorkers', async () => {
    let active = 0;
    let peak = 0;
    const inner = new FunctionNode('track', async (_c, n: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });
    const {output} = await driveNode(
      new ParallelWorker(inner, {maxParallelWorkers: 2}),
      [1, 2, 3, 4, 5],
    );
    expect(output).toEqual([1, 2, 3, 4, 5]);
    // Pin both halves: never more than 2, and it actually reached 2 (this would
    // stay green at peak=1 if the pool regressed to running items serially).
    expect(peak).toBe(2);
  });

  it('does not bound concurrency when maxParallelWorkers is unset', async () => {
    let active = 0;
    let peak = 0;
    const inner = new FunctionNode('track', async (_c, n: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });
    // Matches adk-python, where `max_parallel_workers=None` starts every item
    // of the list at once.
    const {output} = await driveNode(
      new ParallelWorker(inner),
      Array.from({length: 20}, (_v, i) => i),
    );
    expect(output).toHaveLength(20);
    expect(peak).toBe(20);
  });

  it('treats Infinity as unbounded, as the earlier default advertised', async () => {
    let active = 0;
    let peak = 0;
    const inner = new FunctionNode('track', async (_c, n: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n;
    });
    const {output} = await driveNode(
      new ParallelWorker(inner, {maxParallelWorkers: Infinity}),
      Array.from({length: 12}, (_v, i) => i),
    );
    expect(output).toHaveLength(12);
    expect(peak).toBe(12);
  });

  it('rejects maxParallelWorkers < 1', () => {
    const inner = new FunctionNode('x', (_c, v) => v);
    expect(() => new ParallelWorker(inner, {maxParallelWorkers: 0})).toThrow(
      /greater than or equal to 1/,
    );
  });

  it('propagates the first error from a failing item', async () => {
    const inner = new FunctionNode('boom', (_c, n: number) => {
      if (n === 3) {
        throw new Error('boom at 3');
      }
      return n;
    });
    await expect(
      driveNode(new ParallelWorker(inner), [1, 2, 3, 4]),
    ).rejects.toThrow('boom at 3');
  });

  it('fails (not silently) when an item rejects with undefined', async () => {
    const inner = new FunctionNode('bad', (_c, n: number) => {
      if (n === 2) {
        throw undefined; // bare reject: must still count as a failure
      }
      return n;
    });
    let rejected = false;
    try {
      await driveNode(new ParallelWorker(inner), [1, 2, 3]);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  it('emits no list when an item stops to ask the user', async () => {
    const inner = new FunctionNode('maybeAsk', (_c, n: number) => {
      if (n === 2) {
        return new RequestInput({interruptId: `ask-${n}`, message: 'confirm?'});
      }
      return n * 10;
    });
    const {output} = await driveNode(new ParallelWorker(inner), [1, 2, 3]);
    // Not [10, undefined, 30]: a hole would be indistinguishable from an item
    // that legitimately returned nothing, and the worker would report success.
    expect(output).toBeUndefined();
  });

  it('stops claiming items once one interrupts', async () => {
    const started: number[] = [];
    const inner = new FunctionNode('maybeAsk', (_c, n: number) => {
      started.push(n);
      if (n === 1) {
        return new RequestInput({interruptId: 'ask-1', message: 'confirm?'});
      }
      return n;
    });
    await driveNode(
      new ParallelWorker(inner, {maxParallelWorkers: 1}),
      [1, 2, 3],
    );
    expect(started).toEqual([1]);
  });

  it('stops scheduling items once the invocation is aborted', async () => {
    let calls = 0;
    const inner = new FunctionNode('count', (_c, n: number) => {
      calls++;
      return n;
    });
    const controller = new AbortController();
    controller.abort(); // aborted before the run starts
    const ic = createIc({}, controller.signal);

    const {output} = await driveNode(
      new ParallelWorker(inner),
      [1, 2, 3, 4, 5],
      ic,
    );
    // No item was scheduled, and no wrong partial list was emitted.
    expect(calls).toBe(0);
    expect(output).toBeUndefined();
  });
});

describe('ParallelWorker takes what edges take', () => {
  it('maps a bare function across the list without node()', async () => {
    function double(_c: unknown, n: number) {
      return n * 2;
    }
    const {output} = await driveNode(new ParallelWorker(double), [1, 2, 3]);
    expect(output).toEqual([2, 4, 6]);
  });

  it('names itself after the value, as an edge would name it', () => {
    function double(_c: unknown, n: number) {
      return n * 2;
    }
    expect(new ParallelWorker(double).name).toBe('double');
  });

  it('maps a bare agent across the list, with its reply as each output', async () => {
    const worker = new ParallelWorker(replyAgent('reply'));
    const {output} = await driveNode(worker, [1, 2]);
    expect(output).toEqual(['ok', 'ok']);
  });

  it('reports an unnameable value with the builder’s message', () => {
    expect(() => new ParallelWorker((_c: unknown, n: number) => n)).toThrow(
      /has no name; pass \{name\} explicitly/,
    );
  });

  it('still takes an already-built node, unchanged', async () => {
    const inner = new FunctionNode('double', (_c, n: number) => n * 2);
    const worker = new ParallelWorker(inner);
    expect(worker.name).toBe('double');
    expect((await driveNode(worker, [1, 2])).output).toEqual([2, 4]);
  });
});

describe('ParallelWorker registry factory', () => {
  it('buildNode wraps the built node when parallelWorker is requested', () => {
    const node = buildNode((_c: unknown, n: number) => n, {
      name: 'w',
      parallelWorker: true,
    });
    expect(node).toBeInstanceOf(ParallelWorker);
  });

  it('rejects maxParallelWorkers without parallelWorker', () => {
    expect(() =>
      buildNode(() => {}, {name: 'x', maxParallelWorkers: 2}),
    ).toThrow(/maxParallelWorkers can only be set/);
  });
});

describe('JoinNode', () => {
  it('emits its aggregated input as output and requires all predecessors', async () => {
    const join = new JoinNode({name: 'join'});
    const aggregated = {a: 1, b: 2};
    const {output} = await driveNode(join, aggregated);
    expect(output).toEqual(aggregated);
    expect(join.requiresAllPredecessors).toBe(true);
  });
});

describe('ParallelWorker human-in-the-loop', () => {
  async function collect(gen: AsyncGenerator<Event>): Promise<Event[]> {
    const out: Event[] = [];
    for await (const e of gen) {
      out.push(e);
    }
    return out;
  }

  it('pauses the fan-out, then completes it with the answer on resume', async () => {
    const runs: number[] = [];
    const inner = new FunctionNode(
      'review',
      (ctx: NodeContext, n: number) => {
        runs.push(n);
        if (n === 2) {
          const answer = ctx.resumeInputs['ask-2'];
          return answer === undefined
            ? new RequestInput({interruptId: 'ask-2', message: 'confirm 2?'})
            : `2:${answer}`;
        }
        return `${n}:auto`;
      },
      {rerunOnResume: true},
    );

    const wf = new Workflow({
      name: 'pw_hitl_wf',
      dynamicEntry: async (ctx) => {
        const worker = new ParallelWorker(inner, {maxParallelWorkers: 1});
        const result = await ctx.runNode(worker, [1, 2, 3]);
        return result.output;
      },
    });

    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'test_app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'test_app', agent: wf, sessionService});

    const turn1 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'go'}]},
      }),
    );

    expect(turn1.some(hasRequestInputFunctionCall)).toBe(true);
    expect(runs).toEqual([1, 2]);
    // No list yet: emitting one here records a hole for item 2 that the resumed
    // turn would then fast-forward, discarding the answer before it is given.
    expect(turn1.some((e) => Array.isArray(e.output))).toBe(false);

    const turn2 = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'ask-2',
                name: 'adk_request_input',
                response: {result: 'ok'},
              },
            },
          ],
        },
      }),
    );

    // Item 1 is fast-forwarded by run id, item 2 resumes, item 3 runs fresh.
    expect(runs).toEqual([1, 2, 2, 3]);
    expect(turn2.find((e) => Array.isArray(e.output))?.output).toEqual([
      '1:auto',
      '2:ok',
      '3:auto',
    ]);
  });
});

/**
 * Ported from `google/adk-python`
 * `tests/unittests/workflow/test_workflow_parallel_worker.py`. Each `it(...)`
 * keeps the Python test's name so the two suites can be lined up by grep.
 */
describe('ParallelWorker parity with adk-python', () => {
  /** Resolves when `signal` aborts, or after `ms` when it never does. */
  function untilAborted(
    signal: AbortSignal | undefined,
    ms: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        {once: true},
      );
    });
  }

  /** A promise plus the function that settles it. */
  function deferred(): {promise: Promise<void>; resolve: () => void} {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return {promise, resolve};
  }

  it('test_parallel_worker_simultaneous_failures_raise_lowest_index', async () => {
    // The reference loops so that a scheduling-order regression cannot pass by
    // luck. Item 1 is released first on purpose: that is the ordering in which
    // taking the chronologically-first failure gives the wrong answer.
    for (let attempt = 0; attempt < 10; attempt++) {
      const gates = [deferred(), deferred()];
      const started = [deferred(), deferred()];
      const inner = new FunctionNode('boom', async (_c, n: number) => {
        started[n].resolve();
        await gates[n].promise;
        throw new Error(`item-${n} failed`);
      });

      const run = driveNode(new ParallelWorker(inner), [0, 1]);
      await Promise.all([started[0].promise, started[1].promise]);
      gates[1].resolve();
      gates[0].resolve();

      await expect(run).rejects.toThrow('item-0 failed');
    }
  });

  it('test_parallel_worker_retrieves_every_simultaneous_failure', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const gates = [deferred(), deferred()];
      const started = [deferred(), deferred()];
      const inner = new FunctionNode('boom', async (_c, n: number) => {
        started[n].resolve();
        await gates[n].promise;
        throw new Error(`item-${n} failed`);
      });

      const run = driveNode(new ParallelWorker(inner), [0, 1]);
      await Promise.all([started[0].promise, started[1].promise]);
      gates[1].resolve();
      gates[0].resolve();
      await expect(run).rejects.toThrow('item-0 failed');

      // Node reports an unhandled rejection on a later turn of the loop.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('test_parallel_worker_failure_propagates_and_cancels_others', async () => {
    const tracker: number[] = [];
    const parked = deferred();
    const itemZeroDone = deferred();
    let itemTwoCancelled = false;

    const inner = new FunctionNode(
      'failable',
      async (ctx: NodeContext, n: number) => {
        if (n === 0) {
          tracker.push(0);
          itemZeroDone.resolve();
          return 'item-0_processed';
        }
        if (n === 1) {
          // Fail only once item 0 has finished and item 2 is parked, so the
          // assertions below describe a fixed interleaving.
          await itemZeroDone.promise;
          await parked.promise;
          throw new Error('item-1 failed');
        }
        parked.resolve();
        await untilAborted(ctx.abortSignal, 5000);
        itemTwoCancelled = ctx.abortSignal?.aborted === true;
        tracker.push(2);
        return 'item-2_processed';
      },
    );

    await expect(
      driveNode(new ParallelWorker(inner), [0, 1, 2]),
    ).rejects.toThrow('item-1 failed');
    expect(itemTwoCancelled).toBe(true);
    expect(tracker).toEqual([0, 2]);
  });

  it('does not let an interrupted item mask a sibling failure', async () => {
    // Under a scheduler an interrupted child unwinds its caller by throwing,
    // which is a pause. Recorded as a failure it would win on index and hide
    // the sibling's real error.
    const gates = [deferred(), deferred()];
    const started = [deferred(), deferred()];
    const inner = new FunctionNode(
      'mixed',
      async (_c, n: number) => {
        started[n].resolve();
        await gates[n].promise;
        if (n === 0) {
          return new RequestInput({interruptId: 'ask-0', message: 'confirm?'});
        }
        throw new Error('item-1 failed');
      },
      {rerunOnResume: true},
    );

    const wf = new Workflow({
      name: 'pw_interrupt_wf',
      dynamicEntry: async (ctx) => {
        const result = await ctx.runNode(new ParallelWorker(inner), [0, 1]);
        return result.output;
      },
    });

    const run = driveWorkflow(wf);
    await Promise.all([started[0].promise, started[1].promise]);
    gates[0].resolve();
    gates[1].resolve();

    await expect(run).rejects.toThrow('item-1 failed');
  });

  it('does not surface a cancelled item over the failure that cancelled it', async () => {
    const inner = new FunctionNode(
      'mixed',
      async (ctx: NodeContext, n: number) => {
        if (n === 1) {
          throw new Error('item-1 failed');
        }
        await untilAborted(ctx.abortSignal, 5000);
        // A lower index, so it wins the comparison unless it is excluded for
        // being fallout of the cancellation item 1 triggered.
        throw new Error('item-0 cancelled');
      },
    );

    await expect(driveNode(new ParallelWorker(inner), [0, 1])).rejects.toThrow(
      'item-1 failed',
    );
  });

  it('test_parallel_worker_preserves_input_order_regardless_of_completion_order', async () => {
    const finished: number[] = [];
    const inner = new FunctionNode('staggered', async (_c, n: number) => {
      // Item 1 finishes first, so completion order is the reverse of input
      // order and an implementation keyed on completion would be caught.
      await new Promise((r) => setTimeout(r, n === 0 ? 30 : 5));
      finished.push(n);
      return `item-${n}_res`;
    });

    const {output} = await driveNode(new ParallelWorker(inner), [0, 1]);
    expect(finished).toEqual([1, 0]);
    expect(output).toEqual(['item-0_res', 'item-1_res']);
  });

  it('test_parallel_worker_cancels_in_flight_items', async () => {
    const cancelled: boolean[] = [false, false];
    const started = [deferred(), deferred()];
    const inner = new FunctionNode(
      'never',
      async (ctx: NodeContext, n: number) => {
        started[n].resolve();
        await untilAborted(ctx.abortSignal, 5000);
        cancelled[n] = ctx.abortSignal?.aborted === true;
        return n;
      },
    );

    const controller = new AbortController();
    const run = driveNode(
      new ParallelWorker(inner),
      [0, 1],
      createIc({}, controller.signal),
    );
    await Promise.all([started[0].promise, started[1].promise]);
    controller.abort();

    // Bounded so a worker that waits on abandoned items fails here instead of
    // hanging the suite.
    const settled = await Promise.race([
      run.then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('hung'), 2000)),
    ]);
    expect(settled).toBe('settled');
    expect(cancelled).toEqual([true, true]);
  });

  it('test_parallel_worker_gives_up_on_item_that_ignores_cancellation', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const stuck = deferred();
    const stuckStarted = deferred();
    try {
      // Items 0 and 1 fail together, so two claimants try to stop the fan-out
      // and the drain must still run once. Item 2 ignores its cancellation.
      const inner = new FunctionNode('mixed', async (_c, n: number) => {
        if (n === 2) {
          stuckStarted.resolve();
          await stuck.promise;
          return n;
        }
        await stuckStarted.promise;
        throw new Error(`item-${n} failed`);
      });

      const run = driveNode(new ParallelWorker(inner), [0, 1, 2]);
      const rejects = expect(run).rejects.toThrow('item-0 failed');
      // The drain timeout is 5s; without it this advance changes nothing and
      // the run never settles.
      await vi.advanceTimersByTimeAsync(5000);
      await rejects;

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('did not stop within'),
      );
    } finally {
      stuck.resolve();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('warns and stops waiting when the invocation is cancelled during the drain', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const stuck = deferred();
    const stuckStarted = deferred();
    const itemCancelSeen = deferred();
    try {
      const inner = new FunctionNode(
        'mixed',
        async (ctx: NodeContext, n: number) => {
          if (n === 0) {
            await stuckStarted.promise;
            throw new Error('item-0 failed');
          }
          stuckStarted.resolve();
          ctx.abortSignal?.addEventListener(
            'abort',
            () => itemCancelSeen.resolve(),
            {once: true},
          );
          await stuck.promise;
          return n;
        },
      );

      const controller = new AbortController();
      const run = driveNode(
        new ParallelWorker(inner),
        [0, 1],
        createIc({}, controller.signal),
      );
      await itemCancelSeen.promise;
      // The drain starts a few microtasks after the items are cancelled.
      await new Promise((r) => setTimeout(r, 20));
      controller.abort();

      await expect(run).rejects.toThrow('item-0 failed');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('cancelled again while stopping 1 item(s)'),
      );
    } finally {
      stuck.resolve();
      warn.mockRestore();
    }
  });

  it('test_parallel_worker_can_wrap_nested_workflow', async () => {
    function workerFunc(_c: unknown, n: string) {
      return `${n}_processed`;
    }
    const nested = new Workflow({
      name: 'nested_agent',
      edges: [['START', workerFunc]],
    });
    const {output} = await driveNode(new ParallelWorker(nested), [
      'item1',
      'item2',
    ]);
    expect(output).toEqual(['item1_processed', 'item2_processed']);
  });
});

describe('ParallelWorker wrapper options', () => {
  it('carries a retryConfig given to the constructor', () => {
    const inner = new FunctionNode('x', (_c, v) => v);
    const worker = new ParallelWorker(inner, {
      retryConfig: {maxAttempts: 3, exceptions: ['TypeError']},
    });
    expect(worker.retryConfig).toEqual({
      maxAttempts: 3,
      exceptions: ['TypeError'],
    });
    expect(worker.preparedRetryConfig?.maxAttempts).toBe(3);
  });

  it('bounds the whole fan-out with a timeout given to the constructor', async () => {
    const inner = new FunctionNode(
      'slow',
      async (ctx: NodeContext, n: number) => {
        await new Promise((r) => setTimeout(r, 200));
        ctx.abortSignal?.throwIfAborted();
        return n;
      },
    );
    const worker = new ParallelWorker(inner, {timeout: 0.02});
    expect(worker.timeout).toBe(0.02);
    await expect(driveNode(worker, [1, 2])).rejects.toBeInstanceOf(
      NodeTimeoutError,
    );
  });

  it('refuses the START node at construction', () => {
    expect(() => new ParallelWorker(START)).toThrow(/cannot wrap a START node/);
  });

  it('refuses the START sentinel through buildNode with the same message', () => {
    // The constructor's parameter type excludes the `'START'` string, so this
    // is the only way a caller reaches the sentinel by its string form.
    expect(() => buildNode('START', {parallelWorker: true})).toThrow(
      /cannot wrap a START node/,
    );
  });
});
