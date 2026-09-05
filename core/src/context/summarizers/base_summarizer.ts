/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';

import {CompactedEvent} from '../../events/compacted_event.js';

/**
 * Interface for summarizing a list of events into a single CompactedEvent.
 *
 * @experimental  (Experimental, subject to change)
 */
export interface BaseSummarizer {
  /**
   * Summarizes the given events into a CompactedEvent.
   *
   * If compaction failed, return `null`. Otherwise, compact the events into a
   * CompactedEvent and return it. A `null` result is a declined compaction, not
   * an error: the caller leaves the session history exactly as it found it.
   * Throw instead to report a genuine failure.
   *
   * @param events The events to summarize.
   * @returns A promise resolving to the new compacted event, or `null` if no
   *     compaction happened.
   */
  summarize(events: Event[]): Promise<CompactedEvent | null>;
}
