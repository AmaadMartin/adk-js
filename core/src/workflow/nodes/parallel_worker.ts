/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {chainAbortController} from '../../utils/abort_utils.js';
import {logger} from '../../utils/logger.js';
import {BaseNode, START} from '../base_node.js';
import {isNodeInterruptedError} from '../errors.js';
import {RunnableNode} from '../graph.js';
import {NodeContext, NodeResult} from '../node_context.js';
import {RetryConfig} from '../retry_config.js';
import {buildNode} from '../utils/workflow_graph_utils.js';

/**
 * How long to wait for cancelled items to actually stop before giving up on
 * them, so an item that swallows cancellation cannot hang this node forever.
 */
const CANCELLED_ITEM_DRAIN_TIMEOUT_MS = 5000;

/** Options for a {@link ParallelWorker}. */
export interface ParallelWorkerConfig {
  /**
   * Maximum number of items processed concurrently. Unbounded when unset, so
   * every item of the list starts at once.
   */
  maxParallelWorkers?: number;
  /** Retry policy for the fan-out as a whole, not for each item. */
  retryConfig?: RetryConfig;
  /** Deadline, in seconds, for the fan-out as a whole. */
  timeout?: number;
}

/** The failing item whose error the worker surfaces. */
interface ItemFailure {
  index: number;
  error: unknown;
}

/** What one fan-out ended with, for {@link ParallelWorker} to act on. */
interface FanOutResult {
  /** Each item's output, by input index. Has holes when the fan-out stopped. */
  results: unknown[];
  /** The lowest-index item that failed, if any. */
  failure?: ItemFailure;
  /** Whether an item stopped to ask the user. */
  interrupted: boolean;
  /** Interrupt ids collected from the items that asked. */
  interruptIds: string[];
}

/** Why the worker stopped waiting for the items it cancelled. */
type DrainOutcome = 'drained' | 'timedOut' | 'cancelledAgain';

/**
 * A node that runs a wrapped node once per item of a list input, preserving
 * order and stopping on the first error.
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
 * - **The two levels of retry/timeout compose.** `retryConfig`/`timeout` given
 *   to this constructor bound the whole fan-out; the same options on the
 *   wrapped node — `new ParallelWorker(node(myAgent, {timeout: 5}))` — bound
 *   each item.
 * - **All-or-nothing.** If any item throws, its error is rethrown and the
 *   already-computed sibling outputs are discarded. Make individual items
 *   failure-tolerant if partial results matter. When several items fail at
 *   once, the surfaced error is the lowest-index one, so a run and its replay
 *   agree.
 * - **An item that interrupts pauses the whole worker.** It has no output to
 *   contribute, so the worker stops claiming items, emits no list, and raises
 *   the child's interrupt ids as its own. Once they are answered the worker
 *   re-runs from the top (`rerunOnResume`), and items that already completed
 *   are fast-forwarded by their run id rather than executed again.
 * - **Stopping early cancels the items still in flight.** They observe
 *   `ctx.abortSignal`; an item that ignores it is abandoned after
 *   `CANCELLED_ITEM_DRAIN_TIMEOUT_MS`, with a warning.
 */
export class ParallelWorker extends BaseNode {
  readonly maxParallelWorkers?: number;
  private readonly inner: BaseNode;

  constructor(inner: RunnableNode, config: ParallelWorkerConfig = {}) {
    const built = buildNode(inner);
    // Matched by name, the way graph validation identifies the sentinel, so
    // both the `'START'` string and the START node itself are refused.
    if (built.name === START.name) {
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

    const outcome = await this.runItems(ctx, items);

    if (outcome.failure) {
      throw outcome.failure.error;
    }
    if (outcome.interrupted) {
      for (const id of outcome.interruptIds) {
        if (!ctx.interruptIds.includes(id)) {
          ctx.interruptIds.push(id);
        }
      }
      return;
    }
    if (
      ctx.abortSignal?.aborted === true ||
      ctx.invocationContext.abortSignal?.aborted === true
    ) {
      // Aborted mid-flight: `results` may have holes for unscheduled items, so
      // don't emit a wrong partial list — the invocation is being torn down.
      return;
    }
    yield outcome.results;
  }

  /**
   * Runs every item through a pool of `poolSize` claimants and reports what the
   * fan-out ended with. Stopping early cancels the items still in flight, then
   * waits a bounded time for them.
   */
  private async runItems(
    ctx: NodeContext,
    items: unknown[],
  ): Promise<FanOutResult> {
    const results = new Array<unknown>(items.length);
    const interruptIds: string[] = [];
    const poolSize = Math.min(
      this.maxParallelWorkers ?? items.length,
      items.length,
    );
    const parentSignal = ctx.abortSignal ?? ctx.invocationContext.abortSignal;
    const {controller: itemAbort, dispose} = chainAbortController(parentSignal);

    let nextIndex = 0;
    let windingDown = false;
    let interrupted = false;
    let inFlight = 0;
    let claimantsRunning = poolSize;
    let failure: ItemFailure | undefined;
    let settleFanOut!: () => void;
    // Resolved by the last claimant to finish, or early by the drain when an
    // item ignores its cancellation. Resolving it directly, rather than racing
    // the claimants against a deadline, keeps the normal path free of the extra
    // scheduling turns a race costs — the fan-out's timing is observable, since
    // a downstream node reads the session this one is still writing to.
    const fanOutSettled = new Promise<void>((resolve) => {
      settleFanOut = resolve;
    });

    // Waits for the cancelled items to stop, and releases the worker without
    // them when they do not. The wait is bounded because an item that swallows
    // cancellation would otherwise hold the worker here forever. Giving up is
    // never an error: the worker is already unwinding on another one.
    const abandonStalledItems = async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const outcomes: Array<Promise<DrainOutcome>> = [
        fanOutSettled.then(() => 'drained' as const),
        new Promise<DrainOutcome>((resolve) => {
          timer = setTimeout(
            () => resolve('timedOut'),
            CANCELLED_ITEM_DRAIN_TIMEOUT_MS,
          );
        }),
      ];
      // A signal that is already aborted is the reason for this drain, not a
      // second cancellation; only a later abort abandons the wait.
      if (parentSignal && !parentSignal.aborted) {
        outcomes.push(
          new Promise<DrainOutcome>((resolve) => {
            onAbort = () => resolve('cancelledAgain');
            parentSignal.addEventListener('abort', onAbort, {once: true});
          }),
        );
      }

      let outcome: DrainOutcome;
      try {
        outcome = await Promise.race(outcomes);
      } finally {
        clearTimeout(timer);
        if (onAbort) {
          parentSignal?.removeEventListener('abort', onAbort);
        }
      }

      if (outcome === 'drained') {
        return;
      }
      if (outcome === 'timedOut') {
        logger.warn(
          `Node ${this.name}: ${inFlight} item(s) did not stop within ` +
            `${CANCELLED_ITEM_DRAIN_TIMEOUT_MS / 1000}s of being cancelled; ` +
            'abandoning them.',
        );
      } else {
        logger.warn(
          `Node ${this.name}: cancelled again while stopping ${inFlight} item(s).`,
        );
      }
      settleFanOut();
    };

    const stopFanOut = (): void => {
      if (windingDown) {
        return;
      }
      windingDown = true;
      itemAbort.abort();
      void abandonStalledItems();
    };

    // A claimant notices a cancelled invocation at the top of its loop, but one
    // parked on an in-flight item never gets there. Winding down from the
    // signal itself is what bounds that case; `stopFanOut` is idempotent, so
    // the abort it issues re-enters this listener harmlessly.
    if (itemAbort.signal.aborted) {
      stopFanOut();
    } else {
      itemAbort.signal.addEventListener('abort', stopFanOut, {once: true});
    }

    const recordFailure = (index: number, error: unknown): void => {
      // An interrupt is a pause, not a failure. An error from an item this
      // fan-out itself cancelled is cancellation fallout, and must not outrank
      // the failure that caused the cancellation.
      if (isNodeInterruptedError(error) || itemAbort.signal.aborted) {
        return;
      }
      if (!failure || index < failure.index) {
        failure = {index, error};
      }
    };

    // Records before rethrowing, one microtask ahead of the claimant that stops
    // the fan-out. Items that failed in the same wake-up are therefore all
    // considered, and the lowest index wins whichever of them settled first.
    const runItem = async (
      index: number,
    ): Promise<NodeContext | NodeResult> => {
      try {
        // Key each child by its item index (not completion order): the runId
        // makes the run deterministic, and the distinct node path makes each
        // child's events attributable (they'd otherwise all share the inner
        // node's path). The scheduler uses the same runId to fast-forward each
        // item on resume.
        return await ctx.runNode(this.inner, items[index], {
          useSubBranch: true,
          runId: String(index),
          overrideNodePath: `${ctx.nodePath}.${this.inner.name}@${index}`,
          abortSignal: itemAbort.signal,
        });
      } catch (err) {
        recordFailure(index, err);
        throw err;
      }
    };

    // Keeps claiming the next item until the list is exhausted or the fan-out
    // winds down. Never rejects — every item outcome is handled here, which is
    // what lets the claimants run unawaited.
    const claimant = async (): Promise<void> => {
      try {
        for (;;) {
          // A cancelled invocation lands here too: the abort listener above
          // winds the fan-out down before any claimant gets back to this point.
          if (windingDown) {
            return;
          }
          const index = nextIndex++;
          if (index >= items.length) {
            return;
          }
          inFlight++;
          try {
            const child = await runItem(index);
            if (child.interruptIds.length > 0) {
              interrupted = true;
              for (const id of child.interruptIds) {
                if (!interruptIds.includes(id)) {
                  interruptIds.push(id);
                }
              }
              stopFanOut();
              return;
            }
            results[index] = child.output;
          } catch (err) {
            // Inside a workflow the engine unwinds an interrupted caller by
            // throwing rather than returning; that is a pause, not a failure.
            // The ids are already on `ctx`, put there before the throw.
            if (isNodeInterruptedError(err)) {
              interrupted = true;
            }
            stopFanOut();
            return;
          } finally {
            inFlight--;
          }
        }
      } finally {
        if (--claimantsRunning === 0) {
          settleFanOut();
        }
      }
    };

    for (let lane = 0; lane < poolSize; lane++) {
      void claimant();
    }
    try {
      await fanOutSettled;
    } finally {
      dispose();
    }

    return {results, failure, interrupted, interruptIds};
  }
}

// The factory the engine uses to wrap a built node in a ParallelWorker (for
// `buildNode(..., {parallelWorker: true})`) is wired into PARALLEL_WORKER_FACTORY
// in ../node_builders.ts.
