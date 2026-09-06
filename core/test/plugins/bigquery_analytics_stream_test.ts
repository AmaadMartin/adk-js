/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Encodes a real row with the real `@google-cloud/bigquery-storage` encoder.
 *
 * Nothing here is mocked. The rest of the plugin suite fakes the Storage Write
 * API at the module boundary, which means it never runs the JSON-to-proto
 * conversion the transport depends on, and a row whose field types the encoder
 * rejects still passes every one of those tests. This file covers that gap:
 * the schema this plugin declares, converted the way the service converts it,
 * against a row this plugin builds.
 */

import {adapt, managedwriter} from '@google-cloud/bigquery-storage';
import {describe, expect, it} from 'vitest';
import {
  AnalyticsEventType,
  AnalyticsRow,
  AnalyticsStatus,
  AnalyticsStorageMode,
  EVENTS_TABLE_SCHEMA,
} from '../../src/plugins/bigquery_analytics_schema.js';

/** The proto descriptor the service builds from the events table schema. */
function eventsProtoDescriptor() {
  const storageSchema = adapt.convertBigQuerySchemaToStorageTableSchema({
    fields: EVENTS_TABLE_SCHEMA,
  });
  return adapt.convertStorageSchemaToProto2Descriptor(storageSchema, 'root');
}

/**
 * The smallest stand-in for a live stream connection that lets a real
 * `JSONWriter` be built and encode a row.
 *
 * `JSONWriter` registers a schema listener, reads the stream id and hands the
 * encoded request to the connection. Encoding happens before the write, so a
 * connection that only records the request exercises the encoder in full.
 */
class RecordingConnection {
  readonly requests: unknown[] = [];

  onSchemaUpdated(): () => void {
    return () => {};
  }

  getStreamId(): string {
    return 'projects/p/datasets/d/tables/t/streams/_default';
  }

  write(request: unknown): {getResult: () => Promise<unknown>} {
    this.requests.push(request);
    return {getResult: async () => ({})};
  }
}

/**
 * The connection type `JSONWriter` takes, read off its constructor because
 * `@google-cloud/bigquery-storage` does not re-export `StreamConnection`.
 */
type WriterConnection = ConstructorParameters<
  typeof managedwriter.JSONWriter
>[0]['connection'];

/**
 * A real `JSONWriter` over {@link RecordingConnection}.
 *
 * `StreamConnection` is a class with eight private fields, so no object can
 * satisfy its type structurally and a fake of it cannot be typed without one
 * cast. The cast is confined to this line; `JSONWriter` reaches only
 * `onSchemaUpdated`, `getStreamId` and `write`, and all three are real here.
 */
function makeWriter(connection: RecordingConnection): managedwriter.JSONWriter {
  return new managedwriter.JSONWriter({
    connection: connection as unknown as WriterConnection,
    protoDescriptor: eventsProtoDescriptor(),
  });
}

/** One fully populated row, as `logEvent` assembles it. */
function makeRow(): AnalyticsRow {
  return {
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    event_id: 'b8f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5',
    event_type: AnalyticsEventType.LLM_REQUEST,
    agent: 'weather_agent',
    session_id: 's1',
    invocation_id: 'i1',
    user_id: 'u1',
    trace_id: 't1',
    span_id: 'sp1',
    parent_span_id: null,
    content: '{"text_summary":"hello"}',
    content_parts: [
      {
        mime_type: 'text/plain',
        uri: null,
        object_ref: null,
        text: 'hello',
        part_index: 0,
        part_attributes: '{}',
        storage_mode: AnalyticsStorageMode.INLINE,
      },
    ],
    attributes: '{"model":"gemini-2.0-flash"}',
    latency_ms: '{"total_ms":12}',
    status: AnalyticsStatus.OK,
    error_message: null,
    is_truncated: false,
  };
}

describe('events table rows against the real Storage Write API encoder', () => {
  it('builds a proto descriptor from the declared schema', () => {
    expect(eventsProtoDescriptor().field?.map((field) => field.name)).toEqual(
      EVENTS_TABLE_SCHEMA.map((column) => column.name),
    );
  });

  it('encodes a fully populated row', () => {
    const connection = new RecordingConnection();
    makeWriter(connection).appendRows([makeRow()]);
    expect(connection.requests).toHaveLength(1);
  });

  it('encodes a row whose nullable columns are all null', () => {
    const connection = new RecordingConnection();
    makeWriter(connection).appendRows([
      {
        ...makeRow(),
        agent: null,
        span_id: null,
        content: null,
        content_parts: [],
        latency_ms: null,
        error_message: null,
      },
    ]);
    expect(connection.requests).toHaveLength(1);
  });

  it('encodes an error row, so the failure path is not the untested one', () => {
    const connection = new RecordingConnection();
    makeWriter(connection).appendRows([
      {
        ...makeRow(),
        event_type: AnalyticsEventType.TOOL_ERROR,
        status: AnalyticsStatus.ERROR,
        error_message: 'the tool refused the call',
        is_truncated: true,
      },
    ]);
    expect(connection.requests).toHaveLength(1);
  });

  it('refuses an ISO-8601 string in the timestamp column', () => {
    // The encoder maps TIMESTAMP to proto2 int64 and converts only a Date into
    // microseconds. This is why AnalyticsRow.timestamp is a Date; a string
    // reaches protobuf's int64 writer and every append throws.
    const connection = new RecordingConnection();
    const writer = makeWriter(connection);
    // Built as a plain JSON row rather than an AnalyticsRow, because the type
    // this change introduced is exactly what stops a caller writing this.
    const {timestamp: _replaced, ...rest} = makeRow();
    expect(() =>
      writer.appendRows([{...rest, timestamp: '2026-01-01T00:00:00.000Z'}]),
    ).toThrow('interior hyphen');
  });
});
