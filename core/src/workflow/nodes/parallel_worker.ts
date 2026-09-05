/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../../utils/logger.js';
import {BaseNode, START} from '../base_node.js';
import {isNodeInterruptedError} from '../errors.js';
import {RunnableNode} from '../graph.js';
import {NodeContext} from '../node_context.js';
import {RetryConfig} from '../retry_config.js';
import {buildNode} from '../utils/workflow_graph_utils.js';

/**
 * How long to wait for cancelled items to actually stop before giving up on
 * them, so an item that ignores its abort signal cannot hang this node forever.
 * Mirrors `_CANCELLED_ITEM_DRAIN_TIMEOUT_SECONDS` (5.0) in `google/adk-python`
 * `workflow/_parallel_worker.py`.
 */
const CANCELLED_ITEM_DRAIN_TIMEOUT_MS = 5000;

/**
 * Resolves to whether `promise` settled within `ms`. The timer is cleared on
 * both outcomes, so a fan-out that finished never holds the event loop open.
 */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Options for a {@link ParallelWorker}. */
export interface ParallelWorkerConfig {
  /**
   * Maximum number of items processed concurrently. Unbounded when unset, so
   * every item of the list runs at once — set this when the inner node is an
   * LLM or a remote tool and the list length is data-driven.
   */
  maxParallelWorkers?: number;
  /** Retry configuration for the fan-out as a whole. */
  retryConfig?: RetryConfig;
  /** Maximum time, in seconds, for the whole fan-out to complete. */
  timeout?: number;
}

/**
 * A node that runs a wrapped node once per item of a list input, preserving
 * order, bounded by `maxParallelWorkers`, and stopping on the first error.
 * Without `maxParallelWorkers` every item runs at once, matching Python.
 *
 * Ported from `google/adk-python` `workflow/_parallel_worker.py`. A non-list
 * input is treated as a single-element list. Each item runs via
 * `ctx.runNode(inner, item, {useSubBranch: true})`; the node's output is the
 * ordered list of the children's outputs.
 *
 * The wrapped value is anything an edge accepts — an agent, a tool, a plain
 * function, or an already-built node — and is built the same way, so
 * `new ParallelWorker(myAgent)` works without `node(myAgent)`. It is built when
 * the worker is constructed, not per item, so every item runs the one inner
 * node — which is also where the worker's own name comes from.
 *
 * Notes:
 * - **Two levels of retry/timeout.** `retryConfig`/`timeout` in
 *   {@link ParallelWorkerConfig} apply to the fan-out as a whole. The same
 *   options passed to `buildNode` apply to the wrapped node, once per item;
 *   set those by wrapping the value yourself —
 *   `new ParallelWorker(node(myAgent, {timeout: 5}))`.
 * - **All-or-nothing.** If any item throws, one error is rethrown and the
 *   already-computed sibling outputs are discarded. When several items fail
 *   together the lowest input index wins, so the surfaced error is the same on
 *   every run and on replay. Make individual items failure-tolerant if partial
 *   results matter.
 * - **An item that interrupts pauses the whole worker.** It has no output to
 *   contribute, so the worker stops claiming items, emits no list, and raises
 *   the child's interrupt ids as its own. Once they are answered the worker
 *   re-runs from the top (`rerunOnResume`), and items that already completed
 *   are fast-forwarded by their run id rather than executed again.
 * - **Cancellation reaches the items in flight.** On a failure, an interrupt,
 *   an abort or a fired timeout the loop stops claiming new items and each
 *   running item sees its `ctx.abortSignal` fire. Cancellation is cooperative,
 *   so an item that ignores the signal keeps running; the worker waits
 *   {@link CANCELLED_ITEM_DRAIN_TIMEOUT_MS} for it, then warns and abandons it.
 */
export class ParallelWorker extends BaseNode {
  readonly maxParallelWorkers?: number;
  private readonly inner: BaseNode;

  constructor(inner: RunnableNode, config: ParallelWorkerConfig = {}) {
    const built = buildNode(inner);
    // Checked on the built node so the `'START'` literal a JavaScript caller
    // can still pass lands here too: `buildNode` maps it to the sentinel.
    if (built === START) {
      throw new Error('ParallelWorker cannot wrap a START node.');
    }
    super({
      name: built.name,
      rerunOnResume: true,
      retryConfig: config.retryConfig,
      timeout: config.timeout,
    });
    if (
      config.maxParallelWorkers !== undefined &&
      config.maxParallelWorkers < 1
    ) {
      throw new Error('maxParallelWorkers must be greater than or equal to 1.');
    }
    this.inner = built;
    this.maxParallelWorkers = config.maxParallelWorkers;
  }

  protected async *runImpl(
    ctx: NodeContext,
    input: unknown,
  ): AsyncGenerator<unknown, void, void> {
    const items = Array.isArray(input) ? input : [input];
    if (items.length === 0) {
      yield [];
      return;
    }

    const results = new Array<unknown>(items.length);
    const poolSize = Math.min(
      this.maxParallelWorkers ?? items.length,
      items.length,
    );

    let nextIndex = 0;
    let inFlight = 0;
    // Keyed by item index rather than by completion order: when several items
    // fail together the lowest input index is the one that propagates, so the
    // surfaced error is the same on every run and on replay. A Map checked by
    // `.size` rather than a sentinel value, so an item that rejects with
    // `undefined` (a bare `Promise.reject()`) still counts as a failure.
    const errors = new Map<number, unknown>();
    // An item that stops to ask the user has no result to contribute, so the
    // fan-out stops claiming work the same way a failure does.
    let interrupted = false;
    const interruptIds: string[] = [];

    // The signals that would have cancelled the items anyway: the node's own
    // (set by the engine under a deadline or an external abort) and the
    // invocation's.
    const upstream = [
      ...new Set([ctx.abortSignal, ctx.invocationContext.abortSignal]),
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    const isAborted = (): boolean => upstream.some((signal) => signal.aborted);

    // Chained to the upstream signals, so aborting ours stops the items without
    // detaching them from the invocation's or the workflow's signal.
    const itemAbort = new AbortController();
    const childSignal = AbortSignal.any([itemAbort.signal, ...upstream]);

    let resolveStop!: () => void;
    const stopRequested = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    let stopping = false;
    const requestStop = (): void => {
      stopping = true;
      resolveStop();
    };
    for (const signal of upstream) {
      if (signal.aborted) {
        requestStop();
      } else {
        signal.addEventListener('abort', requestStop, {once: true});
      }
    }

    // Keep claiming the next item until the list is exhausted, an item fails or
    // interrupts, or the invocation is aborted.
    const worker = async (): Promise<void> => {
      while (!stopping) {
        const i = nextIndex++;
        if (i >= items.length) {
          break;
        }
        inFlight++;
        try {
          // Key each child by its item index (not completion order): the runId
          // makes the run deterministic, and the distinct node path makes each
          // child's events attributable (they'd otherwise all share the inner
          // node's path). The scheduler uses the same runId to fast-forward each
          // item on resume (lands with the scheduler in a later part).
          const child = await ctx.runNode(this.inner, items[i], {
            useSubBranch: true,
            runId: String(i),
            overrideNodePath: `${ctx.nodePath}.${this.inner.name}@${i}`,
            abortSignal: childSignal,
          });
          if (child.interruptIds.length > 0) {
            if (!itemAbort.signal.aborted) {
              interrupted = true;
              for (const id of child.interruptIds) {
                if (!interruptIds.includes(id)) {
                  interruptIds.push(id);
                }
              }
            }
            requestStop();
            break;
          }
          results[i] = child.output;
        } catch (err: unknown) {
          // Inside a workflow the engine unwinds an interrupted caller by
          // throwing rather than returning; that is a pause, not a failure.
          // The ids are already on `ctx`, put there before the throw.
          if (isNodeInterruptedError(err)) {
            if (!itemAbort.signal.aborted) {
              interrupted = true;
            }
            requestStop();
            break;
          }
          // Only a failure observed before the items were asked to stop is a
          // real one. Anything after that is an item reacting to its own
          // cancellation, which Python likewise discards in its drain.
          if (!itemAbort.signal.aborted) {
            errors.set(i, err);
          }
          requestStop();
          break;
        } finally {
          inFlight--;
        }
      }
    };

    // Workers never reject, so this settles once every item has stopped.
    const pool = Promise.all(Array.from({length: poolSize}, () => worker()));
    try {
      await Promise.race([pool, stopRequested]);
      if (stopping) {
        itemAbort.abort();
        if (!(await settlesWithin(pool, CANCELLED_ITEM_DRAIN_TIMEOUT_MS))) {
          logger.warn(
            `Node ${this.name}: ${inFlight} item(s) did not stop within ` +
              `${CANCELLED_ITEM_DRAIN_TIMEOUT_MS / 1000}s of being cancelled; ` +
              `abandoning them.`,
          );
        }
      }
    } finally {
      for (const signal of upstream) {
        signal.removeEventListener('abort', requestStop);
      }
    }

    if (errors.size > 0) {
      throw errors.get(Math.min(...errors.keys()));
    }
    if (interrupted) {
      for (const id of interruptIds) {
        if (!ctx.interruptIds.includes(id)) {
          ctx.interruptIds.push(id);
        }
      }
      return;
    }
    if (isAborted()) {
      // Aborted mid-flight: `results` may have holes for unscheduled items, so
      // don't emit a wrong partial list — the invocation is being torn down.
      return;
    }
    yield results;
  }
}

// The factory the engine uses to wrap a built node in a ParallelWorker (for
// `buildNode(..., {parallelWorker: true})`) is wired into PARALLEL_WORKER_FACTORY
// in ../node_builders.ts.
