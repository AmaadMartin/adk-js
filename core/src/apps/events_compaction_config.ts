/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseSummarizer} from '../context/summarizers/base_summarizer.js';
import {NumberRange, requireInRange} from '../utils/number_utils.js';

/**
 * How an app compacts the events of a session.
 *
 * Compaction has two independent triggers, and at least one must be
 * configured. The sliding-window trigger (`compactionInterval` with
 * `overlapSize`) compacts every N invocations. The token trigger
 * (`tokenThreshold` with `eventRetentionSize`) compacts once the observed
 * prompt token count reaches the threshold. Mirrors `google/adk-python`
 * `EventsCompactionConfig`.
 */
export interface EventsCompactionConfig {
  /** The summarizer that turns a range of events into one compacted event. */
  summarizer?: BaseSummarizer;

  /** The number of new invocations that trigger a compaction. */
  compactionInterval?: number;

  /**
   * The number of preceding invocations to re-include from the end of the last
   * compacted range, so consecutive summaries overlap.
   */
  overlapSize?: number;

  /** The prompt token count at which a post-invocation compaction runs. */
  tokenThreshold?: number;

  /** The number of most recent events the token trigger leaves un-compacted. */
  eventRetentionSize?: number;
}

type NumericField = Exclude<keyof EventsCompactionConfig, 'summarizer'>;

const NUMERIC_BOUNDS: ReadonlyArray<readonly [NumericField, NumberRange]> = [
  ['compactionInterval', {min: 1}],
  ['overlapSize', {min: 0}],
  ['tokenThreshold', {min: 1}],
  ['eventRetentionSize', {min: 0}],
];

/**
 * Creates an {@link EventsCompactionConfig}, rejecting a configuration that
 * cannot trigger a compaction.
 *
 * @param params Optional partial config. Every field is optional on its own,
 *   but the two trigger pairs are not: each pair is set together or not at all.
 * @returns The validated config.
 * @throws {Error} When only half of a trigger pair is set, when neither
 *   trigger is configured, or when a numeric field is out of bounds.
 */
export function createEventsCompactionConfig(
  params: Partial<EventsCompactionConfig> = {},
): EventsCompactionConfig {
  const config: EventsCompactionConfig = {...params};

  for (const [name, range] of NUMERIC_BOUNDS) {
    const value = config[name];
    if (value !== undefined) {
      requireInRange(name, value, range);
    }
  }

  const hasTokenThreshold = config.tokenThreshold !== undefined;
  const hasRetentionSize = config.eventRetentionSize !== undefined;
  if (hasTokenThreshold !== hasRetentionSize) {
    throw new Error(
      'tokenThreshold and eventRetentionSize must be set together.',
    );
  }

  const hasInterval = config.compactionInterval !== undefined;
  const hasOverlap = config.overlapSize !== undefined;
  if (hasInterval !== hasOverlap) {
    throw new Error('compactionInterval and overlapSize must be set together.');
  }

  if (!hasTokenThreshold && !hasInterval) {
    throw new Error(
      'At least one compaction trigger must be configured: the token-threshold' +
        ' pair or the sliding-window pair.',
    );
  }

  return config;
}
