/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {State} from './state.js';

/**
 * The app-, user-, and session-scoped partitions of a state map.
 */
export interface StateDeltas {
  /** Entries from `app:`-prefixed keys, with the prefix stripped. */
  app: Record<string, unknown>;
  /** Entries from `user:`-prefixed keys, with the prefix stripped. */
  user: Record<string, unknown>;
  /** Entries from unprefixed keys. */
  session: Record<string, unknown>;
}

/**
 * Splits a state map into its app-, user- and session-scoped partitions,
 * stripping the `app:` and `user:` prefixes and dropping `temp:` keys.
 *
 * The inverse of {@link mergeStates}, which re-applies the prefixes.
 *
 * @param state The state to split. Undefined or empty yields empty buckets.
 * @return Freshly allocated app, user and session buckets, each with a null
 *     prototype so that a `__proto__` key becomes an own property instead of
 *     re-parenting the bucket and losing the entry. Values are carried over by
 *     reference; `state` itself is never mutated.
 */
export function extractStateDelta(
  state: Record<string, unknown> | undefined,
): StateDeltas {
  const app: Record<string, unknown> = Object.create(null);
  const user: Record<string, unknown> = Object.create(null);
  const session: Record<string, unknown> = Object.create(null);

  for (const [key, value] of Object.entries(state ?? {})) {
    if (key.startsWith(State.APP_PREFIX)) {
      app[key.slice(State.APP_PREFIX.length)] = value;
    } else if (key.startsWith(State.USER_PREFIX)) {
      user[key.slice(State.USER_PREFIX.length)] = value;
    } else if (!key.startsWith(State.TEMP_PREFIX)) {
      session[key] = value;
    }
  }

  return {app, user, session};
}
