/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isPlainObject} from 'lodash-es';

/**
 * Reports whether `JSON.stringify` renders `value` as `{}`, meaning the value
 * carries data that will not survive serialization.
 *
 * A plain object is exempt: `{}` is a legitimate payload, and skipping it also
 * keeps a large record off the serializer. Only exotic objects -- a `Map`, a
 * `Set`, a `RegExp`, an `Error`, an instance whose state sits behind getters --
 * reach the `JSON.stringify` call, and those are small.
 */
export function rendersAsEmptyJsonObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || isPlainObject(value)) {
    return false;
  }
  try {
    return JSON.stringify(value) === '{}';
  } catch {
    // A circular reference and a bigint both throw here, and both throw again
    // when the caller serializes the value for the wire. That failure is
    // already loud, so this predicate stays quiet about it.
    return false;
  }
}

/**
 * Matches a markdown code fence wrapping an entire payload, capturing its
 * contents. Anchored at both ends so a payload that merely contains backticks
 * is left alone.
 */
const CODE_FENCE_PATTERN = /^```\w*\s*([\s\S]*?)\s*```$/;

/**
 * Removes a markdown code fence wrapping the entire JSON payload, if present.
 *
 * A model asked for structured output occasionally wraps it in a fenced code
 * block, most often when tools are configured alongside an output schema and
 * the schema constraint becomes best-effort. Well-formed JSON never starts
 * with a fence, so this is a no-op on valid input.
 *
 * @param text Model-produced text that is about to be parsed as JSON.
 * @return The fence-free payload, or `text` unchanged when it is not a whole
 *     fenced block.
 */
export function stripJsonCodeFence(text: string): string {
  const match = CODE_FENCE_PATTERN.exec(text.trim());
  return match ? match[1].trim() : text;
}
