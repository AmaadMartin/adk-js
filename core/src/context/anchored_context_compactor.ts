/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {InvocationContext} from '../agents/invocation_context.js';
import type {CompactedEvent} from '../events/compacted_event.js';
import {isScratchpadEvent} from '../events/compacted_event.js';
import type {Event} from '../events/event.js';
import {getEventTokens} from '../events/event.js';
import {applyRewinds} from '../events/rewind_events.js';
import type {BaseContextCompactor} from './base_context_compactor.js';
import {calculateRetainStartIndex} from './compaction_utils.js';
import type {BaseSummarizer} from './summarizers/base_summarizer.js';

export interface AnchoredContextCompactorOptions {
  /** The maximum number of tokens to retain in the session history before compaction. */
  tokenThreshold: number;
  /**
   * The minimum number of raw events to keep at the end of the session.
   * Compaction will not affect these tail events (unless needed for tool splits).
   */
  eventRetentionSize: number;
  /** The summarizer used to create the compacted event content. */
  summarizer: BaseSummarizer;
}

/**
 * A context compactor that maintains a single persistent 'Scratchpad' or
 * 'State Tracker' event at the top of the context history.
 *
 * When compaction is triggered, it merges new raw events into the existing
 * Scratchpad event and discards them from the active history view.
 *
 * Events annulled by a rewind are excluded from the compactable history, so
 * rewound content never enters the scratchpad. The in-place rebuild still
 * works off stored positions rather than the filtered list, so a rewind marker
 * that sits after the compacted window survives in `session.events` and goes
 * on annulling its invocation.
 */
export class AnchoredContextCompactor implements BaseContextCompactor {
  private readonly tokenThreshold: number;
  private readonly eventRetentionSize: number;
  private readonly summarizer: BaseSummarizer;

  constructor(options: AnchoredContextCompactorOptions) {
    this.tokenThreshold = options.tokenThreshold;
    this.eventRetentionSize = options.eventRetentionSize;
    this.summarizer = options.summarizer;
  }

  private getActiveEvents(events: Event[]): Event[] {
    let latestScratchpad: CompactedEvent | undefined = undefined;

    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (isScratchpadEvent(e)) {
        latestScratchpad = e;
        break;
      }
    }

    if (!latestScratchpad) {
      return events;
    }

    const activeRawEvents = events.filter(
      (e) => e.timestamp > latestScratchpad!.endTime && !isScratchpadEvent(e),
    );

    return [latestScratchpad, ...activeRawEvents];
  }

  shouldCompact(
    invocationContext: InvocationContext,
  ): boolean | Promise<boolean> {
    const events = invocationContext.session.events;
    const activeEvents = this.getActiveEvents(events);
    const hasScratchpad =
      activeEvents.length > 0 && isScratchpadEvent(activeEvents[0]);
    const liveRawEvents = applyRewinds(
      hasScratchpad ? activeEvents.slice(1) : activeEvents,
    );

    if (liveRawEvents.length <= this.eventRetentionSize) {
      return false;
    }

    const retainStartIndex = calculateRetainStartIndex(
      liveRawEvents,
      this.eventRetentionSize,
    );
    if (retainStartIndex === 0) {
      return false;
    }

    const totalTokens = activeEvents.reduce(
      (sum, event) => sum + getEventTokens(event),
      0,
    );

    return totalTokens > this.tokenThreshold;
  }

  async compact(invocationContext: InvocationContext): Promise<void> {
    const events = invocationContext.session.events;
    const activeEvents = this.getActiveEvents(events);
    const hasScratchpad =
      activeEvents.length > 0 && isScratchpadEvent(activeEvents[0]);
    const rawEvents = hasScratchpad ? activeEvents.slice(1) : activeEvents;
    // Rewinds are resolved over the whole window before anything is measured
    // or sliced: a marker can sit past the compaction boundary while the
    // invocation it annuls falls inside it, and the guards below have to bound
    // the same list the summarizer receives or they stop bounding it at all.
    const liveRawEvents = applyRewinds(rawEvents);

    if (liveRawEvents.length <= this.eventRetentionSize) {
      return;
    }

    const retainStartIndex = calculateRetainStartIndex(
      liveRawEvents,
      this.eventRetentionSize,
    );

    if (retainStartIndex === 0) {
      // Cannot compact if we have to retain everything
      return;
    }

    const eventsToCompact = liveRawEvents.slice(0, retainStartIndex);

    let scratchpadEvent: CompactedEvent;

    if (hasScratchpad) {
      const existingScratchpad = activeEvents[0] as CompactedEvent;
      scratchpadEvent = await this.summarizer.summarize([
        existingScratchpad,
        ...eventsToCompact,
      ]);
    } else {
      scratchpadEvent = await this.summarizer.summarize(eventsToCompact);
    }

    // Ensure the event is marked as scratchpad and has system author.
    const updatedScratchpad = {
      ...scratchpadEvent,
      isScratchpad: true,
      author: 'system',
    } as CompactedEvent;

    // Reconstruct the events list: inactive events + new scratchpad + active retained events
    const inactiveEvents = events.slice(0, events.indexOf(activeEvents[0]));
    // Retain by stored position rather than by index into the filtered list,
    // so a rewind marker past the compacted window stays in the session and
    // goes on annulling its invocation.
    const lastCompacted = eventsToCompact[eventsToCompact.length - 1];
    const retainedRawEvents = rawEvents.slice(
      rawEvents.indexOf(lastCompacted) + 1,
    );

    const newEventsList = [
      ...inactiveEvents,
      updatedScratchpad,
      ...retainedRawEvents,
    ];

    // Mutate the original session events array.
    events.length = 0;
    events.push(...newEventsList);
  }
}
