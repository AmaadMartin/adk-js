/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {resetLogger, setLogger} from '../../src/utils/logger.js';
import {START} from '../../src/workflow/base_node.js';
import {isNodeTimeoutError} from '../../src/workflow/errors.js';
import {node} from '../../src/workflow/node.js';
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

  it('runs every item concurrently when maxParallelWorkers is unset', async () => {
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
      new ParallelWorker(inner),
      Array.from({length: 20}, (_v, i) => i),
    );
    expect(output).toHaveLength(20);
    expect(peak).toBe(20);
  });

  it('rejects maxParallelWorkers < 1', () => {
    const inner = new FunctionNode('x', (_c, v) => v);
    expect(() => new ParallelWorker(inner, {maxParallelWorkers: 0})).toThrow(
      /greater than or equal to 1/,
    );
  });

  it('rejects a START node in the constructor', () => {
    expect(() => new ParallelWorker(START)).toThrow(
      'ParallelWorker cannot wrap a START node.',
    );
  });

  it('accepts a timeout and passes it to BaseNode', () => {
    const inner = new FunctionNode('x', (_c, v) => v);

    expect(new ParallelWorker(inner, {timeout: 30}).timeout).toBe(30);
  });

  it('fails the fan-out with NodeTimeoutError when the worker timeout fires', async () => {
    const inner = new FunctionNode('slow', async (ctx: NodeContext, n) => {
      await new Promise<void>((resolve) => {
        ctx.abortSignal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
        setTimeout(resolve, 1000);
      });
      return n;
    });
    const worker = new ParallelWorker(inner, {timeout: 0.05});

    const err = await driveNode(worker, [1, 2]).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isNodeTimeoutError(err)).toBe(true);
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

  it('reports an unnameable value with the FunctionNode name error', () => {
    expect(() => new ParallelWorker((_c: unknown, n: number) => n)).toThrow(
      /FunctionNode must have a name/,
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

// The suites below are ported from google/adk-python
// tests/unittests/workflow/test_workflow_parallel_worker.py @ main. Each test
// names the Python test it came from, so a reviewer can grep the original.
describe('ParallelWorker cancellation', () => {
  // test_parallel_worker_failure_propagates_and_cancels_others
  it('propagates the failing item error and stops the ones in flight', async () => {
    const completed: number[] = [];
    let finishItemZero!: () => void;
    const itemZeroDone = new Promise<void>((resolve) => {
      finishItemZero = resolve;
    });
    let parkItemTwo!: () => void;
    const itemTwoParked = new Promise<void>((resolve) => {
      parkItemTwo = resolve;
    });
    let itemTwoCancelled = false;

    // The interleaving is established by handshake rather than by racing
    // sleeps: item 1 may only fail once item 0 has finished and item 2 is
    // parked.
    const inner = new FunctionNode(
      'items',
      async (ctx: NodeContext, n: number) => {
        if (n === 0) {
          completed.push(0);
          finishItemZero();
          return 'item-0_processed';
        }
        if (n === 1) {
          await itemZeroDone;
          await itemTwoParked;
          throw new Error('item-1 failed');
        }
        parkItemTwo();
        await new Promise<void>((resolve) => {
          ctx.abortSignal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
          // Bounded, so a worker that never cancels this item fails the
          // assertions below instead of hanging the runner.
          setTimeout(resolve, 1000);
        });
        itemTwoCancelled = ctx.abortSignal?.aborted === true;
        if (itemTwoCancelled) {
          return undefined;
        }
        completed.push(2);
        return 'item-2_processed';
      },
    );

    await expect(
      driveNode(new ParallelWorker(inner), [0, 1, 2]),
    ).rejects.toThrow('item-1 failed');
    expect(completed).toEqual([0]);
    expect(itemTwoCancelled).toBe(true);
  });

  // test_parallel_worker_cancels_in_flight_items
  it('cancels the items still in flight when the invocation is aborted', async () => {
    const items = [0, 1];
    const startItem: Array<() => void> = [];
    const started = items.map(
      (i) =>
        new Promise<void>((resolve) => {
          startItem[i] = resolve;
        }),
    );
    const cancelled = new Set<number>();

    const inner = new FunctionNode(
      'hang',
      async (ctx: NodeContext, i: number) => {
        startItem[i]();
        await new Promise<void>((resolve) => {
          ctx.abortSignal?.addEventListener(
            'abort',
            () => {
              cancelled.add(i);
              resolve();
            },
            {once: true},
          );
          // Bounded, so an item left running fails the assertion below rather
          // than hanging the runner.
          setTimeout(resolve, 1000);
        });
        return `item-${i}_processed`;
      },
    );

    const controller = new AbortController();
    const run = driveNode(
      new ParallelWorker(inner),
      items,
      createIc({}, controller.signal),
    );
    await Promise.all(started);
    controller.abort();
    const {output} = await run;

    expect([...cancelled].sort()).toEqual(items);
    // Aborted mid-flight, so no partial list is emitted.
    expect(output).toBeUndefined();
  });

  // adk-js regression guard: the worker's own deadline must reach the items.
  // The invocation signal never fires here, so only `ctx.abortSignal` can
  // carry the cancellation.
  it('cancels the items in flight when the worker timeout fires', async () => {
    const items = [0, 1];
    const cancelled = new Set<number>();
    let itemsSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      itemsSettled = resolve;
    });
    let running = items.length;

    const inner = new FunctionNode(
      'hang',
      async (ctx: NodeContext, i: number) => {
        await new Promise<void>((resolve) => {
          ctx.abortSignal?.addEventListener(
            'abort',
            () => {
              cancelled.add(i);
              resolve();
            },
            {once: true},
          );
          // Bounded, so an item left running fails the assertion below rather
          // than hanging the runner.
          setTimeout(resolve, 1000);
        });
        running -= 1;
        if (running === 0) {
          itemsSettled();
        }
        return `item-${i}_processed`;
      },
    );

    const err = await driveNode(
      new ParallelWorker(inner, {timeout: 0.05}),
      items,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    await settled;

    expect(isNodeTimeoutError(err)).toBe(true);
    expect([...cancelled].sort()).toEqual(items);
  });

  // test_parallel_worker_gives_up_on_item_that_ignores_cancellation
  it('gives up on an item that ignores its cancellation, and says so', async () => {
    vi.useFakeTimers({shouldAdvanceTime: true});
    const warnings: string[] = [];
    setLogger({
      setLogLevel: () => {},
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(' '));
      },
      error: () => {},
    });

    let startItem!: () => void;
    const started = new Promise<void>((resolve) => {
      startItem = resolve;
    });
    let releaseItem!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseItem = resolve;
    });

    const inner = new FunctionNode('stubborn', async (_c, item: string) => {
      startItem();
      // Never observes ctx.abortSignal: it keeps running past the cancellation
      // until the test lets go.
      await released;
      return `${item}_processed`;
    });

    try {
      const controller = new AbortController();
      const run = driveNode(
        new ParallelWorker(inner),
        ['item1'],
        createIc({}, controller.signal),
      );
      await started;
      controller.abort();
      // The first pass lets the worker cancel the item and arm its drain
      // timer; the second fires it.
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);
      const {output} = await run;

      expect(warnings.join('\n')).toContain('did not stop within');
      expect(output).toBeUndefined();
    } finally {
      releaseItem();
      resetLogger();
      vi.useRealTimers();
    }
  });

  // adk-js regression guard: the drain cap must not truncate a healthy fan-out.
  it('does not cap a slow fan-out at the drain timeout', async () => {
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      let releaseItems!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseItems = resolve;
      });
      const inner = new FunctionNode('slow', async (_c, n: number) => {
        await released;
        return n * 2;
      });
      let settled = false;
      const run = driveNode(new ParallelWorker(inner), [1, 2]).then(
        (result) => {
          settled = true;
          return result;
        },
      );

      // Three times the drain timeout. Nothing cancelled these items, so the
      // fan-out must still be waiting for them.
      await vi.advanceTimersByTimeAsync(3 * 5000);
      expect(settled).toBe(false);

      releaseItems();
      expect((await run).output).toEqual([2, 4]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ParallelWorker failure ordering', () => {
  // test_parallel_worker_simultaneous_failures_raise_lowest_index
  it('raises the lowest-index failure when items fail together', async () => {
    // Item 1 rejects first in wall-clock order, so a worker that surfaced the
    // first rejection it observed would surface item-1's error.
    const inner = new FunctionNode('fail', async (_c, n: number) => {
      if (n === 0) {
        await Promise.resolve();
      }
      throw new Error(`item-${n} failed`);
    });

    for (let run = 0; run < 10; run++) {
      await expect(
        driveNode(new ParallelWorker(inner), [0, 1]),
      ).rejects.toThrow('item-0 failed');
    }
  });

  // test_parallel_worker_preserves_input_order_regardless_of_completion_order
  it('preserves input order regardless of completion order', async () => {
    const finished: number[] = [];
    const inner = new FunctionNode('delayed', async (_c, n: number) => {
      // Descending delays, so item 0 finishes last.
      await new Promise((resolve) => setTimeout(resolve, (3 - n) * 10));
      finished.push(n);
      return `item${n}_res`;
    });

    const {output} = await driveNode(new ParallelWorker(inner), [0, 1, 2]);

    expect(finished).toEqual([2, 1, 0]);
    expect(output).toEqual(['item0_res', 'item1_res', 'item2_res']);
  });
});

describe('ParallelWorker options inside a real Workflow', () => {
  // The worker's own timeout must bound the fan-out on the path production
  // takes, where ctx.runNode goes through the dynamic scheduler.
  it('fails the fan-out with NodeTimeoutError under a workflow scheduler', async () => {
    const inner = new FunctionNode('slow', async (ctx: NodeContext, n) => {
      await new Promise<void>((resolve) => {
        ctx.abortSignal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
        setTimeout(resolve, 1000);
      });
      return n;
    });
    const worker = new ParallelWorker(inner, {timeout: 0.05});
    const wf = new Workflow({name: 'timeout_wf', edges: [['START', worker]]});

    const err = await driveWorkflow(wf, [1, 2]).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(isNodeTimeoutError(err)).toBe(true);
  });

  // The worker takes no retryConfig; this is the per-item alternative its
  // documentation points at.
  it('retries a single item when the inner node declares a retryConfig', async () => {
    const attempts = new Map<number, number>();
    const flaky = node(
      (_c: NodeContext, n: number) => {
        const seen = (attempts.get(n) ?? 0) + 1;
        attempts.set(n, seen);
        if (n === 1 && seen === 1) {
          throw new Error('first attempt fails');
        }
        return n * 2;
      },
      {
        name: 'flaky',
        retryConfig: {maxAttempts: 2, initialDelay: 0, jitter: 0},
      },
    );
    const wf = new Workflow({
      name: 'item_retry_wf',
      edges: [['START', new ParallelWorker(flaky)]],
    });

    const {output} = await driveWorkflow(wf, [1, 2]);

    expect(output).toEqual([2, 4]);
    expect(attempts.get(1)).toBe(2);
  });
});

describe('ParallelWorker over a nested workflow', () => {
  // test_parallel_worker_can_wrap_nested_workflow
  it('maps a nested workflow across the list', async () => {
    const nested = new Workflow({
      name: 'nested',
      edges: [
        [
          'START',
          new FunctionNode(
            'process',
            (_c, item: string) => `${item}_processed`,
          ),
        ],
      ],
    });

    const {output} = await driveNode(new ParallelWorker(nested), [
      'item1',
      'item2',
    ]);

    expect(output).toEqual(['item1_processed', 'item2_processed']);
  });
});

describe('ParallelWorker human-in-the-loop under a concurrency limit', () => {
  // test_parallel_worker_hitl_respects_parallel_workers_limits
  it('keeps the limit across a pause, then completes on resume', async () => {
    const started: string[] = [];
    const inner = new FunctionNode(
      'review',
      (ctx: NodeContext, item: string) => {
        started.push(item);
        if (item !== 'item1') {
          return `${item}_processed`;
        }
        const answer = ctx.resumeInputs['req_item1'];
        return answer === undefined
          ? new RequestInput({
              interruptId: 'req_item1',
              message: 'Input for item1',
            })
          : `item1_${String(answer)}`;
      },
      {rerunOnResume: true},
    );

    const wf = new Workflow({
      name: 'pw_hitl_limit_wf',
      dynamicEntry: async (ctx) => {
        const worker = new ParallelWorker(inner, {maxParallelWorkers: 2});
        const result = await ctx.runNode(worker, ['item1', 'item2', 'item3']);
        return result.output;
      },
    });

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
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      turn1.push(event);
    }

    expect(turn1.some(hasRequestInputFunctionCall)).toBe(true);
    // The limit of 2 holds across the pause: item3 was never claimed.
    expect(started).toEqual(['item1', 'item2']);
    expect(turn1.some((e) => Array.isArray(e.output))).toBe(false);

    const turn2: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u1',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'req_item1',
              name: 'adk_request_input',
              response: {result: 'ok'},
            },
          },
        ],
      },
    })) {
      turn2.push(event);
    }

    expect(turn2.find((e) => Array.isArray(e.output))?.output).toEqual([
      'item1_ok',
      'item2_processed',
      'item3_processed',
    ]);
  });
});
