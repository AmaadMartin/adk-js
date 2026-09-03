/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isLlmAgent} from '../../agents/llm_agent.js';

import {BaseSummarizer} from './base_summarizer.js';
import {LlmSummarizer} from './llm_summarizer.js';

/**
 * Summarizes with an agent's own model, as `adk-python` does when a compaction
 * policy names no summarizer.
 *
 * Ported from `google/adk-python`
 * `apps/compaction.py::_ensure_compaction_summarizer`.
 *
 * @param agent The agent whose model summarizes. Anything that is not an
 *   `LlmAgent` has no model to borrow.
 * @returns The summarizer, or `undefined` when no model is in play.
 */
export function defaultSummarizer(agent: unknown): BaseSummarizer | undefined {
  return isLlmAgent(agent)
    ? new LlmSummarizer({llm: agent.canonicalModel})
    : undefined;
}
