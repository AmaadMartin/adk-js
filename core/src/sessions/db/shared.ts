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
export const TIMESTAMP_FRACTIONAL_DIGITS = 6;

/** The PostgreSQL column type that stores a JSON object without text. */
const POSTGRES_JSON_COLUMN_TYPE = 'jsonb';

/** The MySQL and MariaDB column type that holds a state larger than 64 KB. */
const MYSQL_JSON_COLUMN_TYPE = 'longtext';

/** The default character set MySQL and MariaDB declare, and nothing else. */
const MYSQL_DEFAULT_CHARSET = 'utf8mb4';

/** Label naming the source of a malformed JSON payload. */
const SESSION_STATE_CONTEXT = 'session state';

const MILLISECONDS_PER_SECOND = 1000;

/** Converts a POSIX-seconds epoch to an instant. */
export function posixSecondsToDate(seconds: number): Date {
  return new Date(seconds * MILLISECONDS_PER_SECOND);
}

/**
 * Reports whether the platform stores a JSON object without serializing it.
 *
 * PostgreSQL is the one supported backend with a native JSON column, which
 * MikroORM declares as `jsonb`.
 */
function storesJsonNatively(platform: Platform): boolean {
  return platform.getJsonDeclarationSQL() === POSTGRES_JSON_COLUMN_TYPE;
}

/**
 * Reports whether the platform speaks the MySQL dialect.
 *
 * MikroORM v6 gives a `Platform` no dialect name, and an `instanceof` check
 * would make the optional MySQL driver a static import of this module.
 * `utf8mb4` is a MySQL character set, so only MySQL and MariaDB declare it.
 * SQLAlchemy reports MariaDB under its `mysql` dialect too, so grouping the
 * two matches the reference.
 */
function usesMySqlDialect(platform: Platform): boolean {
  return platform.getDefaultCharset() === MYSQL_DEFAULT_CHARSET;
}

/** The SQL type a JSON state column takes on the given platform. */
export function dynamicJsonColumnType(platform: Platform): string {
  if (storesJsonNatively(platform)) {
    return POSTGRES_JSON_COLUMN_TYPE;
  }
  if (usesMySqlDialect(platform)) {
    return MYSQL_JSON_COLUMN_TYPE;
  }
  return platform.getTextTypeDeclarationSQL({});
}

/** The SQL type a microsecond-precision timestamp column takes. */
export function preciseTimestampColumnType(platform: Platform): string {
  return platform.getDateTimeTypeDeclarationSQL({
    length: TIMESTAMP_FRACTIONAL_DIGITS,
  });
}

/**
 * Parses stored session state, naming the source when the text is malformed.
 *
 * Mirrors `safe_json_loads(value, context='session state')` in adk-python,
 * which raises `ValueError` instead of letting a decoder error escape.
 */
function parseSessionState(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid JSON in ${SESSION_STATE_CONTEXT}: ${detail}`, {
      cause,
    });
  }
}

/**
 * Stores a JSON object in the widest JSON-capable column a backend supports.
 *
 * PostgreSQL keeps the object in `jsonb`. MySQL and MariaDB use `longtext`,
 * which adk-python picked so a large session state does not overflow a
 * `TEXT` column. Every other backend stores JSON text.
 */
export class DynamicJsonType extends JsonType {
  override getColumnType(_prop: EntityProperty, platform: Platform): string {
    return dynamicJsonColumnType(platform);
  }

  override convertToJSValue(value: unknown): unknown {
    if (typeof value !== 'string') {
      return value;
    }
    return parseSessionState(value);
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
    if (value == null) {
      return value;
    }
    if (typeof value === 'number') {
      return posixSecondsToDate(value);
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
