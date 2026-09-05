/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {toJsonSerializable} from '../utils/json_utils.js';
import {logger} from '../utils/logger.js';
import {State} from './state.js';
import {carryDeltaStamps} from './state_write_order.js';

/** Logged once per call that had to replace at least one state value. */
const LOSSY_STATE_WARNING =
  'Failed to serialize session state; some values are not JSON-serializable' +
  ' (e.g. callables) and will be replaced with a string representation in the' +
  ' persisted state.';

/**
 * A state delta split by the scope each entry belongs to.
 */
export interface ScopedStateDelta {
  /** App-scoped entries, with the `app:` prefix stripped. */
  app: Record<string, unknown>;
  /** User-scoped entries, with the `user:` prefix stripped. */
  user: Record<string, unknown>;
  /** Session-scoped entries. */
  session: Record<string, unknown>;
}

/**
 * Splits a state delta into its app-, user- and session-scoped parts.
 *
 * Each scope is stored separately by a persistent session service, so the
 * `app:` and `user:` prefixes are stripped. `temp:` entries are dropped: they
 * are never persisted.
 *
 * The three maps are null-prototype, because the keys can come straight off a
 * request body. Assigning `__proto__` to a plain object literal reaches the
 * inherited setter and re-parents the map instead of storing the entry.
 */
export function extractStateDelta(
  state: Record<string, unknown>,
): ScopedStateDelta {
  const delta: ScopedStateDelta = {
    app: Object.create(null),
    user: Object.create(null),
    session: Object.create(null),
  };
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith(State.APP_PREFIX)) {
      delta.app[key.slice(State.APP_PREFIX.length)] = value;
    } else if (key.startsWith(State.USER_PREFIX)) {
      delta.user[key.slice(State.USER_PREFIX.length)] = value;
    } else if (!key.startsWith(State.TEMP_PREFIX)) {
      delta.session[key] = value;
    }
  }
  // The session bucket is a different object, so the write order recorded
  // against the original has to come with it or the commit loses its ordering.
  carryDeltaStamps(state, delta.session);
  return delta;
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
