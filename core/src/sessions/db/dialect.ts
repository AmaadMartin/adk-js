/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LockMode, Options as MikroORMOptions} from '@mikro-orm/core';

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
 * Backends whose `DATETIME`/`TIMESTAMP` column drops the time zone.
 *
 * Mirrors adk-python's `_NAIVE_DATETIME_DIALECTS`. Cloud Spanner is absent
 * from both, because its `TIMESTAMP` keeps the zone.
 */
const NAIVE_DATETIME_BACKENDS: ReadonlySet<string> = new Set([
  'mariadb',
  'mssql',
  'mysql',
  'postgres',
  'postgresql',
  'sqlite',
]);

/**
 * Reports whether a backend implements `SELECT ... FOR UPDATE`.
 *
 * sqlite compiles the clause away and mssql turns it into a table hint
 * adk-python never takes, so neither is asked for a row-level lock. An
 * unrecognized backend is not locked either, which is safe everywhere.
 *
 * @param backend The lowercase backend name.
 * @returns True when the backend takes a row-level write lock.
 */
export function supportsRowLevelLocking(backend: string): boolean {
  return ROW_LEVEL_LOCKING_BACKENDS.has(backend);
}

/**
 * Returns the lock mode to read a session row with on a backend.
 *
 * @param backend The lowercase backend name.
 * @returns A write lock on a backend that implements one, and no lock mode on
 *   every other backend.
 */
export function sessionLockMode(backend: string): LockMode | undefined {
  return supportsRowLevelLocking(backend)
    ? LockMode.PESSIMISTIC_WRITE
    : undefined;
}

/**
 * Reports whether a backend stores a datetime without its time zone.
 *
 * @param backend The lowercase backend name.
 * @returns True when the stored column drops the zone.
 */
export function usesNaiveDatetime(backend: string): boolean {
  return NAIVE_DATETIME_BACKENDS.has(backend);
}

/**
 * Returns the connection options that keep a naive-datetime backend on UTC.
 *
 * adk-python strips `tzinfo` before it stores. A TypeScript `Date` carries no
 * zone to strip, so the equivalent is to make the driver and the result mapper
 * both read and write UTC.
 *
 * @param backend The lowercase backend name.
 * @returns `{forceUtcTimezone: true}` for a naive-datetime backend, and no
 *   options for any other backend.
 */
export function naiveDatetimeOptions(
  backend: string,
): Partial<MikroORMOptions> {
  return usesNaiveDatetime(backend) ? {forceUtcTimezone: true} : {};
}
