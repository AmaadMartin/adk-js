/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LockMode} from '@mikro-orm/core';

/**
 * Backends whose dialect implements `SELECT ... FOR UPDATE`.
 *
 * Mirrors adk-python's `_supports_row_level_locking`. `postgres` is the second
 * spelling an adk-js connection URI may use for the same backend, not a second
 * SQLAlchemy dialect.
 */
const ROW_LEVEL_LOCKING_BACKENDS: ReadonlySet<string> = new Set([
  'mariadb',
  'mysql',
  'postgres',
  'postgresql',
]);

/**
 * Returns the lock mode to read a session row with on a backend.
 *
 * sqlite compiles `SELECT ... FOR UPDATE` away and mssql turns it into a table
 * hint adk-python never takes, so neither is asked for a row-level lock. An
 * unrecognized backend is not locked either, which is safe everywhere.
 *
 * @param backend The lowercase backend name.
 * @returns A write lock on a backend that implements one, and no lock mode on
 *   every other backend.
 */
export function sessionLockMode(backend: string): LockMode | undefined {
  return ROW_LEVEL_LOCKING_BACKENDS.has(backend)
    ? LockMode.PESSIMISTIC_WRITE
    : undefined;
}
