/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python test suite for `SqliteSpanExporter`, ported test for test.
 *
 * Source: `tests/unittests/telemetry/test_sqlite_span_exporter.py` on
 * google/adk-python `main`. Every `it(...)` keeps the Python function name
 * verbatim so that either suite can be found from the other by name. The
 * adk-js-specific cases live in `sqlite_span_exporter_adk_js_test.ts`.
 *
 * Three assertions could not be ported literally, and each says why at the
 * test: `test_shutdown_closes_connection` (the reference reads a private
 * field), `test_export_handles_spans_with_none_attributes` and
 * `test_deserialize_handles_invalid_json` (the reference calls a private
 * query helper), and `test_non_serializable_attributes_use_fallback` (JS has
 * no unserializable `AttributeValue`).
 */

import {SqliteSpanExporter} from '@google/adk';
import {MikroORM, RequiredEntityData} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {
  Attributes,
  HrTime,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
} from '@opentelemetry/api';
import {ExportResult, ExportResultCode} from '@opentelemetry/core';
import {emptyResource} from '@opentelemetry/resources';
import {ReadableSpan} from '@opentelemetry/sdk-trace-base';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {ensureDatabaseCreated} from '../../src/sessions/db/operations.js';
import {StorageSpan} from '../../src/telemetry/db/schema.js';

const SESSION_ID_ATTRIBUTE = 'gcp.vertex.agent.session_id';
const INVOCATION_ID_ATTRIBUTE = 'gcp.vertex.agent.invocation_id';
const CONVERSATION_ID_ATTRIBUTE = 'gen_ai.conversation.id';

const DEFAULT_SPAN_ID = 0x00000000000abc12;
const DEFAULT_TRACE_ID = 0x000000000000000000000000000def45;

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

interface CreateSpanOptions {
  spanId?: string;
  traceId?: string;
  parentSpanId?: string;
  name?: string;
  attributes?: Attributes;
  startTime?: HrTime;
  endTime?: HrTime;
}

/**
 * The reference's `_create_span` helper.
 *
 * Every `ReadableSpan` field is populated, so the literal satisfies the
 * interface on its own and no cast is needed.
 */
function createReadableSpan(options: CreateSpanOptions = {}): ReadableSpan {
  const {
    spanId: id = spanId(DEFAULT_SPAN_ID),
    traceId: trace = traceId(DEFAULT_TRACE_ID),
    parentSpanId,
    name = 'test_span',
    attributes = {},
    startTime = unixNanos(1000),
    endTime = unixNanos(2000),
  } = options;

  const spanContext = {
    traceId: trace,
    spanId: id,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  };

  return {
    name,
    kind: SpanKind.INTERNAL,
    spanContext: () => spanContext,
    parentSpanContext: parentSpanId
      ? {...spanContext, spanId: parentSpanId}
      : undefined,
    startTime,
    endTime,
    duration: [0, endTime[1] - startTime[1]],
    status: {code: SpanStatusCode.UNSET},
    attributes,
    links: [],
    events: [],
    ended: true,
    resource: emptyResource(),
    instrumentationScope: {name: 'test', version: '0.0.0'},
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

/** Promisified `export`, since the JS interface reports through a callback. */
function exportSpans(
  exporter: SqliteSpanExporter,
  spans: ReadableSpan[],
): Promise<ExportResult> {
  return new Promise<ExportResult>((resolve) => {
    exporter.export(spans, resolve);
  });
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
  async function readRows(): Promise<StorageSpan[]> {
    const orm = await MikroORM.init({
      dbName: dbPath,
      driver: SqliteDriver,
      entities: [StorageSpan],
    });
    try {
      return await orm.em.fork().find(StorageSpan, {});
    } finally {
      await orm.close();
    }
  }

  /** Writes a row the exporter would never produce, bypassing the mapper. */
  async function writeRow(row: RequiredEntityData<StorageSpan>): Promise<void> {
    const orm = await MikroORM.init({
      dbName: dbPath,
      driver: SqliteDriver,
      entities: [StorageSpan],
    });
    try {
      // The exporter opens the database lazily, so the table may not exist
      // yet. The reference's constructor creates it eagerly.
      await ensureDatabaseCreated(orm);
      const em = orm.em.fork();
      em.create(StorageSpan, row);
      await em.flush();
    } finally {
      await orm.close();
    }
  }

  it('test_export_single_span_returns_success', async () => {
    const span = createReadableSpan({
      name: 'test_operation',
      attributes: {[SESSION_ID_ATTRIBUTE]: 'session-123'},
    });

    const result = await exportSpans(exporter, [span]);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('test_export_empty_list_returns_success', async () => {
    const result = await exportSpans(exporter, []);

    expect(result.code).toBe(ExportResultCode.SUCCESS);
  });

  it('test_get_all_spans_for_session_returns_matching_spans', async () => {
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

  it('test_get_all_spans_for_session_includes_sibling_spans_without_session_id', async () => {
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

  it('test_get_all_spans_for_unknown_session_returns_empty_list', async () => {
    await exportSpans(exporter, [
      createReadableSpan({
        attributes: {[SESSION_ID_ATTRIBUTE]: 'session-123'},
      }),
    ]);

    const result = await exporter.getAllSpansForSession('unknown-session');

    expect(result).toEqual([]);
  });

  it('test_round_trip_preserves_span_attributes', async () => {
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
      traceId: traceId(0xabcdef123456789),
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
    expect(retrieved.spanContext().traceId).toBe(traceId(0xabcdef123456789));
    expect(retrieved.startTime).toEqual(unixNanos(1000000));
    expect(retrieved.endTime).toEqual(unixNanos(2000000));
    expect(retrieved.attributes).toEqual(originalAttributes);
  });

  it('test_spans_with_parent_context_exported_correctly', async () => {
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

  it('test_shutdown_closes_connection', async () => {
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

  it('test_force_flush_returns_true', async () => {
    // `SpanExporter.forceFlush` returns `Promise<void>` in OpenTelemetry JS
    // and takes no timeout, so resolving is the whole contract.
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
  });

  it('test_export_handles_spans_with_none_attributes', async () => {
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

  it('test_duplicate_span_id_replaces_previous_row', async () => {
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

  it('test_non_serializable_attributes_use_fallback', async () => {
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

  it('test_export_multiple_spans_in_batch', async () => {
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

  it('test_export_with_alternative_session_id_attribute', async () => {
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

  it('test_deserialize_handles_invalid_json', async () => {
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

  it('test_get_spans_ordered_by_start_time', async () => {
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
