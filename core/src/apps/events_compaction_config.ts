/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseEventsSummarizer} from './base_events_summarizer.js';

/**
 * The configuration of session-level event compaction for an application.
 *
 * Mirrors the sliding-window half of `google/adk-python`
 * `EventsCompactionConfig`.
 */
export interface EventsCompactionConfig {
  /**
   * The summarizer used for compaction. Defaults to an `LlmEventSummarizer`
   * over the root agent's model.
   */
  summarizer?: BaseEventsSummarizer;

  /**
   * The number of new invocations that, once complete, trigger a compaction.
   * Must be greater than 0.
   */
  compactionInterval: number;

  /**
   * The number of preceding invocations re-included at the start of the window,
   * so consecutive summaries overlap and keep context. Must be 0 or more.
   */
  overlapSize: number;
}

/**
 * Rejects a configuration that cannot drive a compaction.
 *
 * Both window settings must be present and in range, mirroring the pydantic
 * `gt=0` / `ge=0` constraints and the "must be set together" rule in
 * `google/adk-python` `EventsCompactionConfig`.
 *
 * @param config The configuration to validate.
 * @throws Error naming the offending field.
 */
export function validateEventsCompactionConfig(
  config: Partial<EventsCompactionConfig>,
): asserts config is EventsCompactionConfig {
  const {compactionInterval, overlapSize} = config;
  if (compactionInterval === undefined || compactionInterval <= 0) {
    throw new Error(
      `compactionInterval must be greater than 0, got ${compactionInterval}.`,
    );
  }
  if (overlapSize === undefined || overlapSize < 0) {
    throw new Error(`overlapSize must be 0 or more, got ${overlapSize}.`);
  }
}

/**
 * Creates a validated {@link EventsCompactionConfig}.
 *
 * @param params The compaction settings.
 * @returns The validated configuration.
 * @throws Error naming the offending field.
 */
export function createEventsCompactionConfig(
  params: Partial<EventsCompactionConfig>,
): EventsCompactionConfig {
  validateEventsCompactionConfig(params);
  return {
    summarizer: params.summarizer,
    compactionInterval: params.compactionInterval,
    overlapSize: params.overlapSize,
  };
}
