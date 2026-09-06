/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {State} from './state.js';

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

const WRITE_REMEDY =
  'this state is a read-only view of the session. Use a Context ' +
  "(tool/callback) or a workflow node's ctx.state to write state.";

/**
 * The read-only slice of {@link State}: the methods a holder of a read-only
 * view may call.
 *
 * This is an allowlist. A read method added to {@link State} later must be
 * added here deliberately rather than appearing in the view for free.
 */
export type ReadonlyStateView = Pick<State, 'get' | 'has' | 'toRecord'>;

/**
 * A read-through view of session state whose mutators throw.
 *
 * Reads pass through to the record given to the constructor, so the view stays
 * live: a value written to that record by a legitimate writer is visible here.
 *
 * The view is shallow, like the `MappingProxyType` adk-python returns. A nested
 * object obtained from {@link State.get} is the live object and stays mutable.
 */
export class ReadonlyState extends State {
  constructor(value: Record<string, unknown>) {
    super(value, {});
  }

  override set(key: string, _value: unknown): never {
    throw new ReadonlyStateError(`Cannot set '${key}': ${WRITE_REMEDY}`);
  }

  override update(delta: Record<string, unknown>): never {
    const keys = Object.keys(delta).join("', '");
    throw new ReadonlyStateError(`Cannot update '${keys}': ${WRITE_REMEDY}`);
  }
}
