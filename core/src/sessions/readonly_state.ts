/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {State} from './state.js';

/**
 * Where a caller that needs to write state must go instead. Kept in one place
 * so both mutators report the same remedy.
 */
const WRITE_REMEDY =
  'Write session state through a Context (a tool or callback context) or a ' +
  "workflow node's ctx.state.";

/** Raised when a write is attempted on a read-only view of session state. */
export class ReadonlyStateError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'ReadonlyStateError';
    Object.setPrototypeOf(this, ReadonlyStateError.prototype);
  }
}

/** Type guard for {@link ReadonlyStateError}. */
export function isReadonlyStateError(e: unknown): e is ReadonlyStateError {
  return e instanceof Error && e.name === 'ReadonlyStateError';
}

/**
 * The readable slice of {@link State}: the methods a holder of a read-only
 * view may call. An allowlist, so a reader added to `State` later reaches a
 * read-only holder only when it is added here deliberately.
 */
export type ReadonlyStateView = Pick<State, 'get' | 'has' | 'toRecord'>;

/**
 * A read-only view of session state whose mutators throw
 * {@link ReadonlyStateError}.
 *
 * The view holds the session's own record by reference, so reads are live: a
 * value written through a legitimate writer after the view was taken is
 * visible through it. The view is shallow, like Python's `MappingProxyType`:
 * a nested object returned by {@link State.get} is the live object and stays
 * mutable.
 */
export class ReadonlyState extends State {
  constructor(value: Record<string, unknown>) {
    super(value, {});
  }

  override set(key: string, _value: unknown): never {
    throw new ReadonlyStateError(
      `Cannot set '${key}' on a read-only view of session state. ` +
        WRITE_REMEDY,
    );
  }

  override update(delta: Record<string, unknown>): never {
    throw new ReadonlyStateError(
      `Cannot update ${JSON.stringify(Object.keys(delta))} on a read-only ` +
        `view of session state. ${WRITE_REMEDY}`,
    );
  }
}
