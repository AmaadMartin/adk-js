/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds the recorded completion order of a workflow's direct children and owns
 * the {@link ReplaySequenceBarrier}s that replay it.
 *
 * Ported from `google/adk-python` `workflow/utils/_replay_manager.py`. Python's
 * parent-path event index is not ported: it is an O(1) subtree lookup for
 * Python's rehydration path, which `rehydration_utils.ts` implements
 * differently, so an index here would have no reader.
 */

import {Event} from '../../events/event.js';
import type {NodeContext} from '../node_context.js';
import {
  closesRun,
  directChildSegment,
  eventsForCurrentRun,
} from './rehydration_utils.js';
import {ReplaySequenceBarrier} from './replay_sequence_barrier.js';

/** Barrier key for the `runNumber`-th recorded run of the child at `segment`. */
export function sequenceKey(segment: string, runNumber: number): string {
  return `${segment}#${runNumber}`;
}

/**
 * The recorded completion order of `parentPath`'s direct children, as barrier
 * keys.
 *
 * The key's segment is the raw child path segment, so a dynamic
 * (`ctx.runNode`) child keeps the run id its path carries (`child@2`) while a
 * static graph node, whose path carries none, is keyed by its name. The run
 * number counts closed runs of that segment in session order, which is the same
 * positional index `reconstructNodeRuns` assigns and `Workflow.startNodeTask`
 * consumes — the barrier blocks forever on a key nobody advances if the two
 * ever disagree.
 */
export function completionSequence(
  events: Event[],
  parentPath: string,
): string[] {
  const sequence: string[] = [];
  const runNumbers = new Map<string, number>();

  for (const event of events) {
    const path = event.nodeInfo?.path;
    if (!path || !closesRun(event)) {
      continue;
    }
    const segment = directChildSegment(path, parentPath);
    if (segment === undefined) {
      continue;
    }
    const runNumber = (runNumbers.get(segment) ?? 0) + 1;
    runNumbers.set(segment, runNumber);
    sequence.push(sequenceKey(segment, runNumber));
  }

  return sequence;
}

/**
 * Owns one replay barrier per parent path, so a workflow's static graph loop
 * and its dynamic (`ctx.runNode`) children replay against the same recorded
 * order when they share a parent.
 *
 * Stateful with a lifecycle, so a class rather than loose functions; the
 * stateless {@link completionSequence} and {@link sequenceKey} stay at module
 * level.
 */
export class ReplayManager {
  private readonly parentBarriers = new Map<string, ReplaySequenceBarrier>();

  /**
   * The barrier for the direct children of `parentPath`, built on first use.
   *
   * Memoised before the events are read, because every scheduled child under
   * the same parent lands here.
   */
  prepareParentSequenceBarrier(
    ctx: NodeContext,
    parentPath: string,
  ): ReplaySequenceBarrier {
    const memoised = this.parentBarriers.get(parentPath);
    if (memoised) {
      return memoised;
    }
    const barrier = new ReplaySequenceBarrier(
      completionSequence(recordedEvents(ctx), parentPath),
    );
    this.parentBarriers.set(parentPath, barrier);
    return barrier;
  }

  /** Opens the next gate under `parentPath`; a path with no barrier is a no-op. */
  advanceSequence(parentPath: string, key: string): void {
    this.parentBarriers.get(parentPath)?.checkAndAdvance(key);
  }

  /** Waits for `key` under `parentPath`; a path with no barrier never blocks. */
  waitSequence(parentPath: string, key: string): Promise<void> {
    return this.parentBarriers.get(parentPath)?.wait(key) ?? Promise.resolve();
  }
}

/** The session events describing the workflow run still in progress. */
function recordedEvents(ctx: NodeContext): Event[] {
  return eventsForCurrentRun(ctx.session.events, ctx.invocationId);
}
