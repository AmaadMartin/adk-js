/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fencing for untrusted text that reaches a model request.
 *
 * Some of what a request carries is attacker-reachable: another agent's turn, a
 * tool result, a remote peer's agent-card description. It travels on the same
 * text channel the real user speaks on, so text posing as a directive is
 * otherwise indistinguishable from one. Fencing marks where such a payload
 * starts and ends and says, in the message itself, that what sits between the
 * markers is data to read and not instructions to follow.
 *
 * This raises the bar rather than closing the class: a model can still be
 * talked round by text it was told to distrust. What it removes is the
 * structural ambiguity.
 */

/** Opens a fenced block of untrusted content. */
export const QUOTED_CONTENT_BEGIN = '<<<BEGIN_QUOTED_AGENT_CONTENT>>>';

/** Closes a fenced block of untrusted content. */
export const QUOTED_CONTENT_END = '<<<END_QUOTED_AGENT_CONTENT>>>';

/** Replaces a marker found inside content that is about to be fenced. */
export const QUOTED_CONTENT_ELIDED = '<<<ELIDED_MARKER>>>';

/** Removes literal quote markers from relayed content. */
export function elideQuoteMarkers(text: string): string {
  return text
    .split(QUOTED_CONTENT_BEGIN)
    .join(QUOTED_CONTENT_ELIDED)
    .split(QUOTED_CONTENT_END)
    .join(QUOTED_CONTENT_ELIDED);
}

/**
 * Fences relayed content so it cannot pass itself off as instructions.
 *
 * Markers inside the text are elided first, so quoted content cannot forge the
 * end of its own block and carry on speaking as the framework.
 */
export function quoteUntrusted(text: string): string {
  return `${QUOTED_CONTENT_BEGIN}\n${elideQuoteMarkers(text)}\n${QUOTED_CONTENT_END}`;
}
