/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fencing for relayed content that a model reads but must not obey.
 *
 * The markers are wire-observable framing: a cross-language conformance
 * harness compares them, so they match `flows/llm_flows/_fencing.py` in
 * `google/adk-python` character for character.
 */

/** Opening marker of a quoted block. */
export const QUOTED_CONTENT_BEGIN = '<<<BEGIN_QUOTED_AGENT_CONTENT>>>';

/** Closing marker of a quoted block. */
export const QUOTED_CONTENT_END = '<<<END_QUOTED_AGENT_CONTENT>>>';

/** Replaces a marker that the quoted content carried itself. */
export const QUOTED_CONTENT_ELIDED = '<<<ELIDED_MARKER>>>';

/** Removes literal quote markers from relayed content. */
export function elideQuoteMarkers(text: string): string {
  return text
    .replaceAll(QUOTED_CONTENT_BEGIN, QUOTED_CONTENT_ELIDED)
    .replaceAll(QUOTED_CONTENT_END, QUOTED_CONTENT_ELIDED);
}

/**
 * Fences relayed content so it cannot pass itself off as instructions.
 *
 * Markers inside `text` are elided first, so quoted content cannot forge the
 * end of its own block and carry on speaking as the framework.
 */
export function quoteUntrusted(text: string): string {
  return `${QUOTED_CONTENT_BEGIN}\n${elideQuoteMarkers(text)}\n${QUOTED_CONTENT_END}`;
}
