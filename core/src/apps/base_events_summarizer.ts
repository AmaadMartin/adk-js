/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

/**
 * Summarizes a window of session events into a single compaction event.
 *
 * Mirrors `google/adk-python` `BaseEventsSummarizer`. Deciding *when* to
 * compact and *which* events form the window belongs to the compaction driver;
 * a summarizer only turns the window it is handed into a summary.
 */
export interface BaseEventsSummarizer {
  /**
   * Summarizes `events` into one event carrying `actions.compaction`.
   *
   * @param events The events to summarize, in stream order.
   * @returns The compaction event, or `undefined` when no summary was produced.
   */
  maybeSummarizeEvents(events: Event[]): Promise<Event | undefined>;
}
