/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvocationContext} from '../agents/invocation_context.js';
import {Event} from '../events/event.js';
import {AsyncQueue} from '../utils/async_queue.js';
import {logger} from '../utils/logger.js';
import {BaseNode} from '../workflow/base_node.js';
import {runNodeAsInvocation} from '../workflow/run_node_as_invocation.js';

/**
 * Runs a node as the root of a live invocation.
 *
 * Ports `google/adk-python` `live/_runner_utils.py::run_node_live`. The node is
 * driven exactly as it is on the async path — the live delta is only that `ic`
 * carries a `liveRequestQueue` and that the node input is `undefined` — so this
 * delegates to {@link runNodeAsInvocation} instead of forking it.
 *
 * What it adds is the accounting `google/adk-python` does in
 * `runners.py::Runner._cleanup_root_task`: a node that stops because the caller
 * stopped reading is logged and produces no error, while a node that fails is
 * logged and rethrown after the events it already produced.
 */
export async function* runNodeLive(
  node: BaseNode,
  ic: InvocationContext,
): AsyncGenerator<Event, void, void> {
  let settled = false;
  try {
    yield* runNodeAsInvocation(node, ic);
    settled = true;
  } catch (err: unknown) {
    settled = true;
    logger.error(`Live root node '${node.name}' failed.`, err);
    throw err;
  } finally {
    if (!settled) {
      logger.warn(
        `Live root node '${node.name}' was stopped because the caller stopped ` +
          'reading its events.',
      );
    }
  }
}

/** Which of the two merged streams produced a pulled result. */
type MergeSource = 'root' | 'queue';

/** A pulled iterator result, tagged with the stream it came from. */
interface MergePull {
  source: MergeSource;
  result: IteratorResult<Event>;
}

async function pull(
  source: MergeSource,
  iterator: AsyncIterator<Event>,
): Promise<MergePull> {
  return {source, result: await iterator.next()};
}

/**
 * Interleaves a live root's own events with the events pushed onto the
 * invocation's event queue.
 *
 * Code running underneath the root — a streaming tool, or a node tool — has no
 * way to yield an event back through the root's stream, so it pushes onto
 * `InvocationContext.eventQueue` instead. Both streams are raced, so an event
 * reaches the caller as soon as it is produced.
 *
 * Ports `google/adk-python` `runners.py::Runner._merge_live_event_streams`.
 * adk-python pumps both streams into a third queue; racing them instead holds a
 * pull on the root only while the caller wants an event, so the ordinary stop —
 * the caller breaking after a root event — tears the root down at once. The
 * per-event post-processing that adk-python splits between `_exec_with_plugin`
 * and `_consume_event_queue` is a single loop in the caller here, so no event
 * is handled twice.
 *
 * Stopping right after a *queued* event is the one case where the root cannot
 * be torn down at once: a pull on it is necessarily in flight, because that
 * pull is what the code producing the queued event runs inside. The stop is
 * requested and takes effect when the root next produces. Returning to the
 * caller is never delayed by it.
 */
export async function* mergeLiveEventStreams(
  eventQueue: AsyncQueue<Event>,
  rootEvents: AsyncGenerator<Event, void, void>,
): AsyncGenerator<Event, void, void> {
  const queuedEvents = eventQueue[Symbol.asyncIterator]();
  let rootPull: Promise<MergePull> | undefined;
  let queuePull: Promise<MergePull> | undefined;
  let rootDone = false;
  let queueDone = false;

  try {
    while (!rootDone || !queueDone) {
      rootPull ??= rootDone ? undefined : pull('root', rootEvents);
      queuePull ??= queueDone ? undefined : pull('queue', queuedEvents);

      const {source, result} = await Promise.race(
        [rootPull, queuePull].filter((p) => p !== undefined),
      );
      if (source === 'root') {
        rootPull = undefined;
      } else {
        queuePull = undefined;
      }

      if (result.done) {
        if (source === 'root') {
          rootDone = true;
          // Nothing underneath the root can enqueue once the root has stopped,
          // so ending the queue lets what is left in it drain.
          eventQueue.close();
        } else {
          queueDone = true;
        }
        continue;
      }
      yield result.value;
    }
  } finally {
    eventQueue.close();
    const stopped = rootEvents.return();
    if (rootPull) {
      // A pull is still in flight, which is the case whenever the caller stops
      // right after an event that came from the queue. An async generator
      // queues the stop request behind a pending `next()`, so awaiting it here
      // would hold the caller for as long as the root stays idle, and a live
      // root waiting on a silent model connection never resolves it. The stop
      // still runs, as soon as that pull resolves. Nothing reads either outcome
      // now, so both are marked handled to keep a late root failure from
      // surfacing as an unhandled rejection.
      rootPull.catch(ignoreOutcomeAfterStop);
      stopped.catch(ignoreOutcomeAfterStop);
    } else {
      await stopped;
    }
  }
}

/**
 * Discards the outcome of a root pull or stop request that no longer has a
 * reader, so the discard reads as deliberate rather than as a swallowed error.
 */
function ignoreOutcomeAfterStop(): void {}
