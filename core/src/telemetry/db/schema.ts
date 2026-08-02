/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BigIntType, Entity, Index, PrimaryKey, Property} from '@mikro-orm/core';

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
@Index({name: 'spans_session_id_idx', properties: ['sessionId']})
@Index({name: 'spans_trace_id_idx', properties: ['traceId']})
@Entity({tableName: 'spans'})
export class StorageSpan {
  @PrimaryKey({type: 'string', fieldName: 'span_id'})
  spanId!: string;

  @Property({type: 'string', fieldName: 'trace_id'})
  traceId!: string;

  @Property({type: 'string', fieldName: 'parent_span_id', nullable: true})
  parentSpanId?: string;

  @Property({type: 'string'})
  name!: string;

  @Property({
    type: new UnixNanoType(),
    fieldName: 'start_time_unix_nano',
    nullable: true,
  })
  startTimeUnixNano?: string;

  @Property({
    type: new UnixNanoType(),
    fieldName: 'end_time_unix_nano',
    nullable: true,
  })
  endTimeUnixNano?: string;

  @Property({type: 'string', fieldName: 'session_id', nullable: true})
  sessionId?: string;

  @Property({type: 'string', fieldName: 'invocation_id', nullable: true})
  invocationId?: string;

  @Property({type: 'text', fieldName: 'attributes_json', nullable: true})
  attributesJson?: string;
}
