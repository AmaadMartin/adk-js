/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Splitting a state delta by scope, and coercing its values into a form a JSON
 * column can hold.
 *
 * These belong to session state rather than to any one backend, which is where
 * adk-python keeps them too (`sessions/_session_util.py`).
 */

import {Event} from '../events/event.js';
import {logger} from '../utils/logger.js';
import {State} from './state.js';

/** A state delta split by the scope each key is stored in. */
export interface ScopedStateDelta {
  /** Keys that were `app:`-prefixed, with the prefix stripped. */
  app: Record<string, unknown>;
  /** Keys that were `user:`-prefixed, with the prefix stripped. */
  user: Record<string, unknown>;
  /** Keys belonging to the session alone. `temp:` keys are dropped. */
  session: Record<string, unknown>;
}

/** Returns whether a JSON column can hold `value` as it stands. */
function isJsonSafe(value: unknown): boolean {
  try {
    // `undefined` means JSON dropped the value outright: a function, a
    // symbol, or `undefined` itself. A BigInt or a cycle throws instead.
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

/** Coerces one delta value into a form a JSON column can hold. */
function toJsonSafe(key: string, value: unknown): unknown {
  if (isJsonSafe(value)) {
    return value;
  }
  logger.warn(
    `Session state key "${key}" is not JSON-serializable; persisting its` +
      ' string representation instead.',
  );
  return String(value);
}

/**
 * Splits a state delta into its app, user and session scopes, coercing every
 * value into a JSON-serializable form.
 *
 * A value a JSON column cannot hold is replaced with its string
 * representation rather than failing the whole write, so a lossy write is
 * diagnosable instead of fatal.
 *
 * @param state The delta to split, with its keys still prefixed.
 * @return The three scopes, as null-prototype maps.
 */
export function extractJsonSafeStateDelta(
  state: Record<string, unknown>,
): ScopedStateDelta {
  // Null-prototype maps: `state` can arrive straight off a request body, and
  // assigning a `__proto__` key to a plain object literal invokes the
  // inherited setter, which re-parents the map instead of storing the entry.
  const deltas: ScopedStateDelta = {
    app: Object.create(null),
    user: Object.create(null),
    session: Object.create(null),
  };
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith(State.APP_PREFIX)) {
      deltas.app[key.slice(State.APP_PREFIX.length)] = toJsonSafe(key, value);
    } else if (key.startsWith(State.USER_PREFIX)) {
      deltas.user[key.slice(State.USER_PREFIX.length)] = toJsonSafe(key, value);
    } else if (!key.startsWith(State.TEMP_PREFIX)) {
      deltas.session[key] = toJsonSafe(key, value);
    }
  }
  return deltas;
}

/**
 * Coerces the event's state delta in place, so one value a JSON column cannot
 * hold cannot fail the whole write.
 *
 * Call this after `trimTempDeltaState`, which rebuilds the delta map, so that
 * the caller's own delta object keeps its values.
 *
 * @param event The event whose delta is about to be persisted.
 */
export function makeDeltaJsonSafe(event: Event): void {
  const stateDelta = event.actions.stateDelta;
  for (const [key, value] of Object.entries(stateDelta)) {
    stateDelta[key] = toJsonSafe(key, value);
  }
}
