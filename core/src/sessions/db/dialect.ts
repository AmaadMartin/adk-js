/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Options as MikroORMOptions} from '@mikro-orm/core';

/**
 * Backends whose DATETIME/TIMESTAMP columns drop the time zone, mirroring
 * adk-python's `_NAIVE_DATETIME_DIALECTS`.
 *
 * adk-python lists sqlite, postgresql, mysql and mariadb. mssql is listed here
 * as well because adk-js supports it and its `datetime2` drops the zone too.
 * Cloud Spanner is the backend the reference excludes, because its TIMESTAMP
 * keeps the zone; adk-js ships no Spanner driver.
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
 * Reports whether a backend stores a datetime without its zone.
 *
 * @param backend The backend name, as a connection URI scheme names it or as
 *   the open connection reports it.
 * @returns True when the backend drops the zone.
 */
export function usesNaiveDatetime(backend: string): boolean {
  return NAIVE_DATETIME_BACKENDS.has(backend);
}

/**
 * Returns the connection options that keep a naive-datetime backend on UTC.
 *
 * `forceUtcTimezone` makes the mysql, mariadb and mssql drivers send and read
 * wall clocks in UTC instead of the Node process's local zone, and it makes
 * MikroORM read a zone-less string back as UTC on every backend. Without it,
 * what `createSession` writes and what storage reads back differ by the local
 * offset, and a session adk-python wrote resolves to the wrong instant.
 * PostgreSQL already defaults it to true; naming it here keeps the decision in
 * one place.
 *
 * @param backend The backend the connection URI names.
 * @returns The options to merge in, empty for a zone-aware backend.
 */
export function naiveDatetimeOptions(
  backend: string,
): Partial<MikroORMOptions> {
  return usesNaiveDatetime(backend) ? {forceUtcTimezone: true} : {};
}
