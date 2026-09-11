/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isJsonSafe, toJsonSafe} from '../utils/json_utils.js';
import {logger} from '../utils/logger.js';
import {State} from './state.js';

/**
 * A state map split by the scope its keys belong to.
 *
 * The keys in `app` and `user` have lost their `app:` and `user:` prefix: that
 * is the form a session service writes to its shared app-state and user-state
 * records.
 */
export interface StateDelta {
  /** Values scoped to the whole application. */
  app: Record<string, unknown>;
  /** Values scoped to one user of the application. */
  user: Record<string, unknown>;
  /** Values scoped to this session alone. */
  session: Record<string, unknown>;
}

/**
 * Splits a state map into its app, user and session scopes.
 *
 * `temp:` keys are dropped: they live only for the current invocation and no
 * session service persists them.
 */
export function extractStateDelta(
  state: Record<string, unknown> = {},
): StateDelta {
  // Null-prototype: a `__proto__` key copied into a plain object literal
  // invokes the inherited setter, which re-parents the object instead of
  // storing the entry. See `trimTempState` in `base_session_service.ts`.
  const delta: StateDelta = {
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
  return delta;
}

/**
 * Coerces a state map into a form that survives a JSON write.
 *
 * A session service that persists state as JSON must use this rather than
 * writing the raw map: a value JSON cannot represent is replaced with its
 * string form instead of being dropped or failing the whole write. One
 * warning is logged when a replacement was needed, so a lossy write is
 * diagnosable.
 */
export function makeJsonSafeState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  if (!isJsonSafe(state)) {
    logger.warn(
      'Session state holds values that JSON cannot represent. They are ' +
        'persisted as their string form, so reading the session back returns ' +
        'the string rather than the original value.',
    );
  }
  return toJsonSafe(state);
}
