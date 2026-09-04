/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Storage column types shared by the session schema.
 *
 * Ported from `src/google/adk/sessions/schemas/shared.py` in
 * google/adk-python. Each type picks the widest JSON-capable and the most
 * precise timestamp representation a database backend supports, so a table
 * this SDK creates matches the one adk-python creates.
 */

import {EntityProperty, JsonType, Platform, Type} from '@mikro-orm/core';

/** Longest value a non-key varchar column stores. */
export const DEFAULT_MAX_VARCHAR_LENGTH = 256;

/** Fractional-second digits a timestamp column keeps. */
const TIMESTAMP_FRACTIONAL_DIGITS = 6;

/** The SQL type a JSON state column takes on the given platform. */
export function dynamicJsonColumnType(platform: Platform): string {
  const declared = platform.getJsonDeclarationSQL();
  // PostgreSQL is the one supported backend with a native JSON column.
  if (declared === 'jsonb') {
    return declared;
  }
  // MikroORM v6 gives a `Platform` no dialect name, and an `instanceof` check
  // would make the optional MySQL driver a static import of this module.
  // `utf8mb4` is a MySQL character set, so only MySQL and MariaDB declare it,
  // and SQLAlchemy reports MariaDB under its `mysql` dialect too. `longtext`
  // is what adk-python picked so a large state does not overflow `TEXT`.
  if (platform.getDefaultCharset() === 'utf8mb4') {
    return 'longtext';
  }
  // adk-python falls back to `TEXT` here because SQLAlchemy has no portable
  // JSON type. MikroORM has one, so a backend keeps the declaration it already
  // uses: `json` on SQLite and Unicode `nvarchar(max)` on SQL Server.
  return declared;
}

/** The SQL type a microsecond-precision timestamp column takes. */
export function preciseTimestampColumnType(platform: Platform): string {
  return platform.getDateTimeTypeDeclarationSQL({
    length: TIMESTAMP_FRACTIONAL_DIGITS,
  });
}

/**
 * Stores a JSON object in the widest JSON-capable column a backend supports.
 *
 * PostgreSQL keeps the object in `jsonb`. MySQL and MariaDB use `longtext`,
 * which adk-python picked so a large session state does not overflow a
 * `TEXT` column. Every other backend keeps its own JSON declaration.
 */
export class DynamicJsonType extends JsonType {
  override getColumnType(_prop: EntityProperty, platform: Platform): string {
    return dynamicJsonColumnType(platform);
  }

  override convertToJSValue(value: unknown): unknown {
    if (typeof value !== 'string') {
      return value;
    }
    // Mirrors `safe_json_loads(value, context='session state')` in
    // adk-python, which raises instead of letting a decoder error escape.
    try {
      return JSON.parse(value);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Invalid JSON in session state: ${detail}`, {cause});
    }
  }
}

/**
 * Stores an instant with the fractional seconds a backend can keep.
 *
 * MySQL and MariaDB need an explicit `datetime(6)`, and SQL Server needs
 * `datetime2(6)`, or the fractional seconds of an update marker are lost and
 * the optimistic-concurrency check rejects a row it just wrote.
 *
 * The type extends `Type` rather than `DateTimeType` because a stored
 * timestamp can read back as SQL `NULL`, which `DateTimeType` cannot express:
 * it declares `Date` as its runtime type.
 */
export class PreciseTimestampType extends Type<
  Date | null,
  string | number | Date | null
> {
  override getColumnType(_prop: EntityProperty, platform: Platform): string {
    return preciseTimestampColumnType(platform);
  }

  override convertToJSValue(
    value: string | number | Date | null,
    platform: Platform,
  ): Date | null {
    // MikroORM counts an epoch in milliseconds, not the POSIX seconds
    // adk-python reads: `BaseSqlitePlatform.processDateProperty` stores a
    // `Date` as `+value`, and `Platform.parseDate` reads it as `new Date(value)`.
    if (typeof value === 'number') {
      return new Date(value);
    }
    if (typeof value === 'string') {
      return platform.parseDate(value);
    }
    return value;
  }

  override compareAsType(): string {
    return 'Date';
  }

  override get runtimeType(): string {
    return 'Date';
  }

  override ensureComparable(): boolean {
    return false;
  }
}
