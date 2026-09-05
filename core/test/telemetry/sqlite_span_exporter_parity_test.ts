/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python test suite for `SqliteSpanExporter`, ported test for test.
 *
 * Source: `tests/unittests/telemetry/test_sqlite_span_exporter.py` on
 * google/adk-python `main`. Each `it(...)` carries the Python function name
 * in a comment above it, so either suite can be found from the other by
 * name. The adk-js suite lives in `sqlite_span_exporter_test.ts`.
 *
 * Three assertions could not be ported literally, and each says why at the
 * test: `test_shutdown_closes_connection` (the reference reads a private
 * field), `test_export_handles_spans_with_none_attributes` and
 * `test_deserialize_handles_invalid_json` (the reference calls a private
 * query helper), and `test_non_serializable_attributes_use_fallback` (JS has
 * no unserializable `AttributeValue`).
 */

import {SqliteSpanExporter} from '@google/adk';
import {RequiredEntityData} from '@mikro-orm/core';
import {Attributes, HrTime} from '@opentelemetry/api';
import {ExportResultCode} from '@opentelemetry/core';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ensureDatabaseCreated} from '../../src/sessions/db/operations.js';
import {StorageSpan} from '../../src/telemetry/db/schema.js';
import {
  CONVERSATION_ID_ATTRIBUTE,
  createReadableSpan,
  exportSpans,
  INVOCATION_ID_ATTRIBUTE,
  SESSION_ID_ATTRIBUTE,
  withDatabase,
} from './sqlite_span_exporter_test_utils.js';

/**
 * The reference's `trace_id=0xABCDEF123456789`, written out.
 *
 * Python integers are arbitrary precision; this one is above
 * `Number.MAX_SAFE_INTEGER`, so a JS numeric literal would round it.
 */
const ROUND_TRIP_TRACE_ID = '00000000000000000abcdef123456789';

/**
 * Formats a numeric id as OpenTelemetry JS models it.
 *
 * The reference writes `format(span_id, '016x')` on the way to the database,
 * so the same literals produce the same bytes on disk. Keeping the numeric
 * literals here keeps each test readable against its Python original.
 */
function spanId(value: number): string {
  return value.toString(16).padStart(16, '0');
}

function traceId(value: number): string {
  return value.toString(16).padStart(32, '0');
}

/** Python's `start_time=1000`: an epoch nanosecond count as an `HrTime`. */
function unixNanos(nanos: number): HrTime {
  return [0, nanos];
}

describe('SqliteSpanExporter ported from adk-python', () => {
  let tempDir: string;
  let dbPath: string;
  let exporter: SqliteSpanExporter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'adk-sqlite-span-exporter-ref-'));
    dbPath = join(tempDir, 'test.db');
    exporter = new SqliteSpanExporter({dbPath});
  });

  afterEach(async () => {
    await exporter.shutdown();
    await rm(tempDir, {recursive: true, force: true});
  });

  /** Reads the rows the exporter wrote, through a connection of its own. */
  function readRows(): Promise<StorageSpan[]> {
    return withDatabase(dbPath, (orm) => orm.em.fork().find(StorageSpan, {}));
  }

  /** Writes a row the exporter would never produce, bypassing the mapper. */
  function writeRow(row: RequiredEntityData<StorageSpan>): Promise<void> {
    return withDatabase(dbPath, async (orm) => {
      // The exporter opens the database lazily, so the table may not exist
      // yet. The reference's constructor creates it eagerly.
      await ensureDatabaseCreated(orm);
      const em = orm.em.fork();
      em.create(StorageSpan, row);
      await em.flush();
    });
  }

  // test_export_single_span_returns_success
  it('reports success and creates the database file for one span', async () => {
    const span = createReadableSpan({
      name: 'test_operation',
      attributes: {[SESSION_ID_ATTRIBUTE]: 'session-123'},
    });

    const result = await exportSpans(exporter, [span]);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(existsSync(dbPath)).toBe(true);
  });

  // test_export_empty_list_returns_success
  it('reports success for an empty batch', async () => {
    const result = await exportSpans(exporter, []);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
  });

  // test_get_all_spans_for_session_returns_matching_spans
  it('returns the spans of the requested session only', async () => {
    const span1 = createReadableSpan({
      spanId: spanId(0x111),
      traceId: traceId(0xaaa111),
      attributes: {[SESSION_ID_ATTRIBUTE]: 'session-123'},
      name: 'span1',
    });
    const span2 = createReadableSpan({
      spanId: spanId(0x222),
      traceId: traceId(0xaaa222),
      attributes: {[SESSION_ID_ATTRIBUTE]: 'session-123'},
      name: 'span2',
    });
    const span3 = createReadableSpan({
      spanId: spanId(0x333),
      traceId: traceId(0xbbb333),
      attributes: {[SESSION_ID_ATTRIBUTE]: 'session-456'},
      name: 'span3',
    });

    await exportSpans(exporter, [span1, span2, span3]);

    const result = await exporter.getAllSpansForSession('session-123');

    expect(result).toHaveLength(2);
    const names = result.map((span) => span.name);
    expect(names).toContain('span1');
    expect(names).toContain('span2');
    expect(names).not.toContain('span3');
  });

  // test_get_all_spans_for_session_includes_sibling_spans_without_session_id
  it('includes the trace siblings that carry no session id', async () => {
    const parentSpan = createReadableSpan({
      spanId: spanId(0x100),
      traceId: traceId(0xaaa),
      name: 'invocation',
      attributes: {},
    });
    const childSpan = createReadableSpan({
      spanId: spanId(0x200),
      traceId: traceId(0xaaa),
      parentSpanId: spanId(0x100),
      name: 'call_llm',
      attributes: {[SESSION_ID_ATTRIBUTE]: 'session-789'},
    });
    const siblingSpan = createReadableSpan({
      spanId: spanId(0x300),
      traceId: traceId(0xaaa),
      parentSpanId: spanId(0x100),
      name: 'tool_call',
      attributes: {},
    });
    const unrelatedSpan = createReadableSpan({
      spanId: spanId(0x400),
      traceId: traceId(0xbbb),
      name: 'unrelated',
      attributes: {},
    });

    await exportSpans(exporter, [
      parentSpan,
      childSpan,
      siblingSpan,
      unrelatedSpan,
    ]);

    const result = await exporter.getAllSpansForSession('session-789');

    expect(result).toHaveLength(3);
    const names = result.map((span) => span.name);
    expect(names).toContain('invocation');
    expect(names).toContain('call_llm');
    expect(names).toContain('tool_call');
    expect(names).not.toContain('unrelated');
  });

  // test_get_all_spans_for_unknown_session_returns_empty_list
  it('returns an empty list for an unknown session', async () => {
    await exportSpans(exporter, [
      createReadableSpan({
        attributes: {[SESSION_ID_ATTRIBUTE]: 'session-123'},
      }),
    ]);

    const result = await exporter.getAllSpansForSession('unknown-session');

    expect(result).toEqual([]);
  });

  // test_round_trip_preserves_span_attributes
  it('preserves the span attributes across a round trip', async () => {
    // The reference also round-trips `"dict.value": {"nested": "data"}`.
    // OpenTelemetry JS types an attribute as a primitive or an array of one,
    // so a nested object cannot be set here and is covered instead by the
    // dropped-entry case in `db/span_mapper_test.ts`.
    const originalAttributes: Attributes = {
      [SESSION_ID_ATTRIBUTE]: 'session-123',
      [INVOCATION_ID_ATTRIBUTE]: 'invocation-456',
      [CONVERSATION_ID_ATTRIBUTE]: 'conv-789',
      'custom.attribute': 'test_value',
      'numeric.value': 42,
      'boolean.value': true,
      'list.value': [1, 2, 3],
    };

    const originalSpan = createReadableSpan({
      spanId: spanId(0x12345678),
      traceId: ROUND_TRIP_TRACE_ID,
      name: 'test_operation',
      attributes: originalAttributes,
      startTime: unixNanos(1000000),
      endTime: unixNanos(2000000),
    });

    await exportSpans(exporter, [originalSpan]);

    const retrievedSpans = await exporter.getAllSpansForSession('session-123');

    expect(retrievedSpans).toHaveLength(1);
    const retrieved = retrievedSpans[0];

    expect(retrieved.name).toBe('test_operation');
    expect(retrieved.spanContext().spanId).toBe(spanId(0x12345678));
    expect(retrieved.spanContext().traceId).toBe(ROUND_TRIP_TRACE_ID);
    expect(retrieved.startTime).toEqual(unixNanos(1000000));
    expect(retrieved.endTime).toEqual(unixNanos(2000000));
    expect(retrieved.attributes).toEqual(originalAttributes);
  });

  // test_spans_with_parent_context_exported_correctly
  it('restores the parent context of a child span', async () => {
    const parentSpan = createReadableSpan({
      spanId: spanId(0xaaa),
      traceId: traceId(0x123),
      name: 'parent',
      attributes: {[SESSION_ID_ATTRIBUTE]: 'session-001'},
    });
    const childSpan = createReadableSpan({
      spanId: spanId(0xbbb),
      traceId: traceId(0x123),
      parentSpanId: spanId(0xaaa),
      name: 'child',
      attributes: {[SESSION_ID_ATTRIBUTE]: 'session-001'},
    });

    await exportSpans(exporter, [parentSpan, childSpan]);

    const retrievedSpans = await exporter.getAllSpansForSession('session-001');

    expect(retrievedSpans).toHaveLength(2);

    const child = retrievedSpans.find((span) => span.name === 'child');
    const parent = retrievedSpans.find((span) => span.name === 'parent');
    if (!child || !parent) {
      expect.fail('expected both the parent and the child span');
    }
    // The reference reads `child.parent`; OpenTelemetry JS 2.x renamed the
    // field to `parentSpanContext`.
    expect(child.parentSpanContext?.spanId).toBe(spanId(0xaaa));
    expect(child.parentSpanContext?.traceId).toBe(traceId(0x123));
    expect(parent.parentSpanContext).toBeUndefined();
  });

  // test_shutdown_closes_connection
  it('releases the connection on shutdown and reopens it lazily', async () => {
    await exportSpans(exporter, [
      createReadableSpan({
        attributes: {[SESSION_ID_ATTRIBUTE]: 'session-close'},
      }),
    ]);

    // The reference asserts `exporter._conn is None`. Reaching a private
    // member from a test is not allowed here, so this pins the behaviour that
    // field exists for: the connection is released, and a later call reopens
    // it lazily.
    await expect(exporter.shutdown()).resolves.toBeUndefined();
    await expect(exporter.shutdown()).resolves.toBeUndefined();

    const reopened = await exporter.getAllSpansForSession('session-close');
    expect(reopened).toHaveLength(1);
  });

  // test_force_flush_returns_true
  it('resolves forceFlush', async () => {
    // `SpanExporter.forceFlush` returns `Promise<void>` in OpenTelemetry JS
    // and takes no timeout, so resolving is the whole contract.
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
  });

  // test_export_handles_spans_with_none_attributes
  it('stores a span that carries no attributes', async () => {
    // `ReadableSpan.attributes` is not nullable in OpenTelemetry JS, so the
    // empty object is the analogue of the reference's `attributes=None`.
    const span = createReadableSpan({attributes: {}});

    const result = await exportSpans(exporter, [span]);

    expect(result.code).toBe(ExportResultCode.SUCCESS);

    // The reference reads the row through the private `_query`. Reading it
    // through a separate connection asserts the on-disk schema instead, which
    // is the contract shared with adk-python.
    await exporter.shutdown();
    const rows = await readRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].attributesJson ?? '')).toEqual({});
  });

  // test_duplicate_span_id_replaces_previous_row
  it('replaces the previous row when a span id repeats', async () => {
    await exportSpans(exporter, [
      createReadableSpan({
        spanId: spanId(0x999),
        name: 'first_version',
        attributes: {version: 1, [SESSION_ID_ATTRIBUTE]: 'session-dup'},
      }),
    ]);

    await exportSpans(exporter, [
      createReadableSpan({
        spanId: spanId(0x999),
        name: 'second_version',
        attributes: {version: 2, [SESSION_ID_ATTRIBUTE]: 'session-dup'},
      }),
    ]);

    const retrievedSpans = await exporter.getAllSpansForSession('session-dup');
    expect(retrievedSpans).toHaveLength(1);
    expect(retrievedSpans[0].name).toBe('second_version');
    expect(retrievedSpans[0].attributes['version']).toBe(2);
  });

  // test_non_serializable_attributes_use_fallback
  it('falls back to empty attributes when serialization throws', async () => {
    // The reference builds an arbitrary Python object and expects the
    // per-value sentinel `"<not serializable>"`. TypeScript has no
    // unserializable `AttributeValue`, and `JSON.stringify` has no per-value
    // substitution hook, so the JS analogue is a value that makes the whole
    // encode throw. The exporter then stores `'{}'` for the span, which drops
    // the siblings the reference would have kept.
    const attributes: Attributes = {
      [SESSION_ID_ATTRIBUTE]: 'session-nonser',
      normal_attr: 'value',
    };
    Object.defineProperty(attributes, 'non_serializable', {
      enumerable: true,
      get(): string {
        throw new TypeError('this value cannot be serialized');
      },
    });

    const result = await exportSpans(exporter, [
      createReadableSpan({attributes}),
    ]);

    expect(result.code).toBe(ExportResultCode.SUCCESS);

    const retrievedSpans =
      await exporter.getAllSpansForSession('session-nonser');
    expect(retrievedSpans).toHaveLength(1);
    expect(retrievedSpans[0].attributes).toEqual({});
  });

  // test_export_multiple_spans_in_batch
  it('exports every span of a batch', async () => {
    const spans = Array.from({length: 10}, (_, i) =>
      createReadableSpan({
        spanId: spanId(i),
        name: `span_${i}`,
        attributes: {[SESSION_ID_ATTRIBUTE]: 'batch-session'},
      }),
    );

    const result = await exportSpans(exporter, spans);

    expect(result.code).toBe(ExportResultCode.SUCCESS);

    const retrievedSpans =
      await exporter.getAllSpansForSession('batch-session');
    expect(retrievedSpans).toHaveLength(10);
    const names = new Set(retrievedSpans.map((span) => span.name));
    expect(names).toEqual(
      new Set(Array.from({length: 10}, (_, i) => `span_${i}`)),
    );
  });

  // test_export_with_alternative_session_id_attribute
  it('indexes a span by the conversation id attribute', async () => {
    await exportSpans(exporter, [
      createReadableSpan({
        attributes: {[CONVERSATION_ID_ATTRIBUTE]: 'conv-session-123'},
      }),
    ]);

    const result = await exporter.getAllSpansForSession('conv-session-123');

    expect(result).toHaveLength(1);
    expect(result[0].attributes[CONVERSATION_ID_ATTRIBUTE]).toBe(
      'conv-session-123',
    );
  });

  // test_deserialize_handles_invalid_json
  it('returns empty attributes for a row holding invalid JSON', async () => {
    // The reference inserts through `_get_connection` and reads back through
    // the private `_query` and `_row_to_readable_span`. Writing the row on a
    // separate connection and reading it through the public API covers the
    // same decode path without reaching into the exporter.
    await writeRow({
      spanId: 'abc123',
      traceId: 'def456',
      name: 'test',
      sessionId: 'session-invalid-json',
      attributesJson: 'not valid json',
    });

    const spans = await exporter.getAllSpansForSession('session-invalid-json');

    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('test');
    expect(spans[0].attributes).toEqual({});
  });

  // test_get_spans_ordered_by_start_time
  it('returns the spans ordered by start time', async () => {
    const attributes = {[SESSION_ID_ATTRIBUTE]: 'session-order'};
    const spans = [
      createReadableSpan({
        spanId: spanId(0x300),
        startTime: unixNanos(3000),
        attributes,
      }),
      createReadableSpan({
        spanId: spanId(0x100),
        startTime: unixNanos(1000),
        attributes,
      }),
      createReadableSpan({
        spanId: spanId(0x200),
        startTime: unixNanos(2000),
        attributes,
      }),
    ];

    await exportSpans(exporter, spans);

    const result = await exporter.getAllSpansForSession('session-order');

    expect(result).toHaveLength(3);
    expect(result[0].spanContext().spanId).toBe(spanId(0x100));
    expect(result[1].spanContext().spanId).toBe(spanId(0x200));
    expect(result[2].spanContext().spanId).toBe(spanId(0x300));
  });
});
