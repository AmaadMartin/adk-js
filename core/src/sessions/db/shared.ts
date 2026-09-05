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

/**
 * Rewrites a timestamp declaration that keeps a time zone into the naive one.
 *
 * adk-python declares a plain `DateTime` for every session timestamp, which
 * is `TIMESTAMP WITHOUT TIME ZONE` on PostgreSQL, and writes a naive UTC
 * value into it. `_NAIVE_DATETIME_DIALECTS` and `_uses_naive_datetime` in
 * `database_session_service.py` name the four dialects that behave this way:
 * sqlite, postgresql, mysql and mariadb. MikroORM gives a `Platform` no
 * dialect name — the constraint {@link DynamicJsonType} documents — so the
 * decision is read off the declaration the platform emits instead. Only
 * PostgreSQL emits a zone-carrying one; every other backend adk-js supports
 * already declares a naive column and passes through unchanged.
 *
 * @param declaration The declaration the platform emits.
 * @returns The declaration, with any time zone dropped.
 */
function withoutTimeZone(declaration: string): string {
  return declaration.replace(/^timestamptz/, 'timestamp');
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
    // MikroORM v6 gives a `Platform` no dialect name, and an `instanceof`
    // check would make the optional MySQL driver a static import of this
    // module. `utf8mb4` is a MySQL character set, so only MySQL and MariaDB
    // declare it, and SQLAlchemy reports MariaDB under its `mysql` dialect
    // too. `longtext` is what adk-python picked so a large state does not
    // overflow `TEXT`.
    if (platform.getDefaultCharset() === 'utf8mb4') {
      return 'longtext';
    }
    // adk-python falls back to `TEXT` here because SQLAlchemy has no portable
    // JSON type. MikroORM has one, so a backend keeps the declaration it
    // already uses: `jsonb` on PostgreSQL, `json` on SQLite and Unicode
    // `nvarchar(max)` on SQL Server.
    return platform.getJsonDeclarationSQL();
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
 * The column keeps no time zone, matching the one adk-python declares. See
 * {@link withoutTimeZone}.
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
    return withoutTimeZone(
      platform.getDateTimeTypeDeclarationSQL({
        length: TIMESTAMP_FRACTIONAL_DIGITS,
      }),
    );
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
