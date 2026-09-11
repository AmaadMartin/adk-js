/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BigIntType, EntitySchema} from '@mikro-orm/core';

/**
 * An epoch-nanosecond column, stored as a SQL `bigint` and read as a string.
 *
 * The `bigint` column keeps the on-disk value identical to the adk-python
 * exporter. The read is cast to text because the `sqlite3` driver hands
 * JavaScript a double for integer columns, which rounds epoch nanoseconds
 * (~1.7e18, far above `Number.MAX_SAFE_INTEGER`).
 *
 * The cast also applies to `ORDER BY`, which would then sort lexicographically,
 * so callers must order these values themselves.
 */
class UnixNanoType extends BigIntType<'string'> {
  constructor() {
    super('string');
  }

  override convertToJSValueSQL(key: string): string {
    return `cast(${key} as text)`;
  }
}

// The entity below is a plain class paired with an `EntitySchema`, rather than a
// decorated class. MikroORM v7 moved the decorators into `@mikro-orm/decorators`,
// whose legacy entry pulls in `reflect-metadata`; declaring the mapping
// separately keeps both off the dependency list while leaving the class usable
// as a value (`em.create(StorageSpan, ...)`) and as a type
// (`EntityData<StorageSpan>`) exactly as before. This mirrors the
// `DatabaseSessionService` schema in `sessions/db/schema.ts`.

/**
 * A single exported OpenTelemetry span, persisted by `SqliteSpanExporter`.
 *
 * The table and column names mirror the adk-python exporter so that a database
 * file written by either implementation is readable by the other.
 *
 * Timestamps are stored as `bigint` columns and surfaced as strings: epoch
 * nanoseconds exceed `Number.MAX_SAFE_INTEGER`, so a `number` mapping would
 * silently round them. See {@link UnixNanoType}.
 */
export class StorageSpan {
  spanId!: string;
  traceId!: string;
  parentSpanId?: string;
  name!: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  sessionId?: string;
  invocationId?: string;
  attributesJson?: string;
}

export const storageSpanSchema = new EntitySchema<StorageSpan>({
  class: StorageSpan,
  tableName: 'spans',
  indexes: [
    {name: 'spans_session_id_idx', properties: ['sessionId']},
    {name: 'spans_trace_id_idx', properties: ['traceId']},
  ],
  properties: {
    spanId: {type: 'string', fieldName: 'span_id', primary: true},
    traceId: {type: 'string', fieldName: 'trace_id'},
    parentSpanId: {type: 'string', fieldName: 'parent_span_id', nullable: true},
    name: {type: 'string'},
    startTimeUnixNano: {
      type: new UnixNanoType(),
      fieldName: 'start_time_unix_nano',
      nullable: true,
    },
    endTimeUnixNano: {
      type: new UnixNanoType(),
      fieldName: 'end_time_unix_nano',
      nullable: true,
    },
    sessionId: {type: 'string', fieldName: 'session_id', nullable: true},
    invocationId: {type: 'string', fieldName: 'invocation_id', nullable: true},
    attributesJson: {
      type: 'text',
      fieldName: 'attributes_json',
      nullable: true,
    },
  },
});
