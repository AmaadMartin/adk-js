/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fencing for untrusted text that is relayed into a model request.
 *
 * Some of what a request carries is attacker-reachable: another agent's turn, a
 * tool result, a remote agent card's description. It travels on the same text
 * channel the real user speaks on, so text posing as a directive is otherwise
 * indistinguishable from one. Fencing marks where such a payload starts and
 * ends. This raises the bar rather than closing the class: a model can still be
 * talked round by text it was told to distrust. What it removes is the
 * structural ambiguity.
 *
 * Ported from `google/adk-python` `flows/llm_flows/_fencing.py`.
 */

/** Marks the start of a quoted, untrusted block. */
export const QUOTED_CONTENT_BEGIN = '<<<BEGIN_QUOTED_AGENT_CONTENT>>>';

/** Marks the end of a quoted, untrusted block. */
export const QUOTED_CONTENT_END = '<<<END_QUOTED_AGENT_CONTENT>>>';

/** Replaces a marker that the quoted payload spelled out itself. */
export const QUOTED_CONTENT_ELIDED = '<<<ELIDED_MARKER>>>';

/**
 * Removes literal quote markers from relayed content.
 *
 * @param text The relayed content.
 * @return The content with every begin and end marker replaced by
 *   {@link QUOTED_CONTENT_ELIDED}.
 */
export function elideQuoteMarkers(text: string): string {
  return text
    .replaceAll(QUOTED_CONTENT_BEGIN, QUOTED_CONTENT_ELIDED)
    .replaceAll(QUOTED_CONTENT_END, QUOTED_CONTENT_ELIDED);
}

/**
 * Fences relayed content so it cannot pass itself off as instructions.
 *
 * @param text The relayed content to quote.
 * @return The text between the quote markers. Markers inside the text are
 *   elided first, so quoted content cannot forge the end of its own block and
 *   carry on speaking as the framework.
 */
export function quoteUntrusted(text: string): string {
  return `${QUOTED_CONTENT_BEGIN}\n${elideQuoteMarkers(text)}\n${QUOTED_CONTENT_END}`;
}
