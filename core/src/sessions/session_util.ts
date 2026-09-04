/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {toJsonSerializable} from '../utils/json_utils.js';
import {logger} from '../utils/logger.js';
import {extractStateDelta, ScopedStateDelta} from './base_session_service.js';
import {carryDeltaStamps} from './state_write_order.js';

/** Logged once per call that had to replace at least one state value. */
const LOSSY_STATE_WARNING =
  'Failed to serialize session state; some values are not JSON-serializable' +
  ' (e.g. callables) and will be replaced with a string representation in the' +
  ' persisted state.';

/**
 * Returns `value` as `T` when it is a decodable model payload, else undefined.
 *
 * A session store can hand back a primitive where a model was expected: a
 * legacy or corrupted `"null"` string persisted in place of SQL NULL, or a
 * backend that serialized an empty message as `[]`. Passing that on as a model
 * breaks session replay, so it is dropped instead.
 *
 * Only the payload's shape is checked. A non-null, non-array object is
 * returned unchanged, which mirrors what the wire format already guarantees
 * for these fields.
 */
export function decodeModel<T>(value: unknown): T | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as T;
}

/**
 * Coerces every value of a state map into a JSON-serializable form.
 *
 * A service that persists state to a JSON column must use this. A value JSON
 * cannot represent — a function, a symbol, a `BigInt`, a circular structure —
 * is replaced with a string stand-in, so one bad value cannot fail the whole
 * write or vanish without trace. Rich types with a `toJSON` method, `Date`
 * among them, keep their faithful representation. The value itself is never
 * logged.
 *
 * The result is a null-prototype map, for the reason `trimTempState`
 * documents: a `__proto__` key assigned to a plain object literal reaches the
 * inherited setter and re-parents the map.
 */
export function makeJsonSafeState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  let replaced = false;
  const safe: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(state)) {
    safe[key] = toJsonSerializable(value, () => {
      replaced = true;
    });
  }
  if (replaced) {
    logger.warn(LOSSY_STATE_WARNING);
  }
  // This is another copy on the way from the writer to the commit, so the
  // write order recorded against the original has to come with it.
  carryDeltaStamps(state, safe);
  return safe;
}

/**
 * Splits a state delta by scope, with every value coerced into a
 * JSON-serializable form.
 *
 * The counterpart of adk-python's `extract_json_safe_state_delta`. Coercion
 * runs before the split, so the three buckets keep the null prototype
 * {@link extractStateDelta} gives them.
 */
export function extractJsonSafeStateDelta(
  state: Record<string, unknown>,
): ScopedStateDelta {
  return extractStateDelta(makeJsonSafeState(state));
}
