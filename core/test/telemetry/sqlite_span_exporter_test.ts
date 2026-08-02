/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getLogger,
  Logger,
  LogLevel,
  setLogger,
  SqliteSpanExporter,
} from '@google/adk';
import {MikroORM} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import {
  Attributes,
  context,
  HrTime,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
} from '@opentelemetry/api';
import {ExportResult, ExportResultCode} from '@opentelemetry/core';
import {emptyResource} from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {existsSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {StorageSpan} from '../../src/telemetry/db/schema.js';
import {describeError} from '../../src/telemetry/sqlite_span_exporter.js';

const SESSION_ID_ATTRIBUTE = 'gcp.vertex.agent.session_id';
const CONVERSATION_ID_ATTRIBUTE = 'gen_ai.conversation.id';

interface TestSpanOverrides {
  spanId?: string;
  traceId?: string;
  parentSpanId?: string;
  name?: string;
  attributes?: Attributes;
  startTime?: HrTime;
  endTime?: HrTime;
}

/** Builds a fully populated `ReadableSpan`, so no cast is ever needed. */
function createTestSpan(overrides: TestSpanOverrides = {}): ReadableSpan {
  const {
    spanId = '00000000000abc12',
    traceId = '000000000000000000000000000def45',
    parentSpanId,
    name = 'test_span',
    attributes = {},
    startTime = [0, 1000],
    endTime = [0, 2000],
  } = overrides;

  const spanContext = {
    traceId,
    spanId,
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
    duration: [0, 1000],
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

/** Promisified `export`, so tests can await the exporter's result callback. */
function exportSpans(
  exporter: SqliteSpanExporter,
  spans: ReadableSpan[],
): Promise<ExportResult> {
  return new Promise<ExportResult>((resolve) => {
    exporter.export(spans, resolve);
  });
}

/** Collects everything ADK logs, so tests can assert on it. */
class RecordingLogger implements Logger {
  readonly lines: string[] = [];

  log(level: LogLevel, ...args: unknown[]): void {
    this.lines.push(args.map(String).join(' '));
  }
  debug(...args: unknown[]): void {
    this.log(LogLevel.DEBUG, ...args);
  }
  info(...args: unknown[]): void {
    this.log(LogLevel.INFO, ...args);
  }
  warn(...args: unknown[]): void {
    this.log(LogLevel.WARN, ...args);
  }
  error(...args: unknown[]): void {
    this.log(LogLevel.ERROR, ...args);
  }
  setLogLevel(): void {}
}

describe('SqliteSpanExporter', () => {
  let tempDir: string;
  let dbPath: string;
  let exporters: SqliteSpanExporter[];

  function createExporter(path = dbPath): SqliteSpanExporter {
    const exporter = new SqliteSpanExporter({dbPath: path});
    exporters.push(exporter);
    return exporter;
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'adk-sqlite-span-exporter-'));
    dbPath = join(tempDir, 'test.db');
    exporters = [];
  });

  afterEach(async () => {
    for (const exporter of exporters) {
      await exporter.shutdown();
    }
    await rm(tempDir, {recursive: true, force: true});
  });

  describe('export', () => {
    it('returns success for a single span and creates the database file', async () => {
      const exporter = createExporter();

      const result = await exportSpans(exporter, [
        createTestSpan({
          name: 'test_operation',
          attributes: {[SESSION_ID_ATTRIBUTE]: 'session-123'},
        }),
      ]);

      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(existsSync(dbPath)).toBe(true);
    });

    it('returns success for an empty batch without touching the database', async () => {
      const exporter = createExporter();

      const result = await exportSpans(exporter, []);

      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(existsSync(dbPath)).toBe(false);
    });

    it('persists every span of a batch', async () => {
      const exporter = createExporter();
      const spans = Array.from({length: 10}, (_, i) =>
        createTestSpan({
          spanId: `000000000000000${i}`,
          name: `span_${i}`,
          attributes: {[SESSION_ID_ATTRIBUTE]: 'batch-session'},
        }),
      );

      const result = await exportSpans(exporter, spans);

      expect(result.code).toBe(ExportResultCode.SUCCESS);
      const retrieved = await exporter.getAllSpansForSession('batch-session');
      expect(retrieved.map((span) => span.name).sort()).toEqual(
        spans.map((span) => span.name).sort(),
      );
    });

    it('stores an empty attributes object as an empty JSON object', async () => {
      const exporter = createExporter();

      await exportSpans(exporter, [
        createTestSpan({attributes: {[SESSION_ID_ATTRIBUTE]: 'session-empty'}}),
      ]);

      const [retrieved] = await exporter.getAllSpansForSession('session-empty');
      expect(retrieved.attributes).toEqual({
        [SESSION_ID_ATTRIBUTE]: 'session-empty',
      });
    });

    it('replaces the previous row when the same span id is exported twice', async () => {
      const exporter = createExporter();
      const attributes = {[SESSION_ID_ATTRIBUTE]: 'session-dup'};

      await exportSpans(exporter, [
        createTestSpan({
          spanId: '0000000000000999',
          name: 'first_version',
          attributes: {...attributes, version: 1},
        }),
      ]);
      await exportSpans(exporter, [
        createTestSpan({
          spanId: '0000000000000999',
          name: 'second_version',
          attributes: {...attributes, version: 2},
        }),
      ]);

      const retrieved = await exporter.getAllSpansForSession('session-dup');
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].name).toBe('second_version');
      expect(retrieved[0].attributes['version']).toBe(2);
    });

    it('keeps the last version of a span id repeated within one batch', async () => {
      const exporter = createExporter();
      const attributes = {[SESSION_ID_ATTRIBUTE]: 'session-batch-dup'};

      const result = await exportSpans(exporter, [
        createTestSpan({spanId: '0000000000000abc', name: 'first', attributes}),
        createTestSpan({spanId: '0000000000000def', name: 'other', attributes}),
        createTestSpan({
          spanId: '0000000000000abc',
          name: 'middle',
          attributes,
        }),
        createTestSpan({spanId: '0000000000000abc', name: 'last', attributes}),
      ]);

      expect(result.code).toBe(ExportResultCode.SUCCESS);
      const retrieved =
        await exporter.getAllSpansForSession('session-batch-dup');
      expect(retrieved.map((span) => span.name).sort()).toEqual([
        'last',
        'other',
      ]);
    });

    it('indexes a span that only carries the conversation id attribute', async () => {
      const exporter = createExporter();

      await exportSpans(exporter, [
        createTestSpan({
          attributes: {[CONVERSATION_ID_ATTRIBUTE]: 'conv-session-123'},
        }),
      ]);

      const retrieved =
        await exporter.getAllSpansForSession('conv-session-123');
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].attributes[CONVERSATION_ID_ATTRIBUTE]).toBe(
        'conv-session-123',
      );
    });

    it('prefers the session id attribute over the conversation id attribute', async () => {
      const exporter = createExporter();

      await exportSpans(exporter, [
        createTestSpan({
          attributes: {
            [SESSION_ID_ATTRIBUTE]: 'session-preferred',
            [CONVERSATION_ID_ATTRIBUTE]: 'conv-ignored',
          },
        }),
      ]);

      expect(
        await exporter.getAllSpansForSession('session-preferred'),
      ).toHaveLength(1);
      expect(await exporter.getAllSpansForSession('conv-ignored')).toEqual([]);
    });

    it('stores a span whose session id attribute is not a string without indexing it', async () => {
      const exporter = createExporter();

      const result = await exportSpans(exporter, [
        createTestSpan({
          traceId: '000000000000000000000000000000aa',
          attributes: {[SESSION_ID_ATTRIBUTE]: 42},
        }),
      ]);

      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(await exporter.getAllSpansForSession('42')).toEqual([]);
    });

    it('reports failure without throwing when the database file is not a database', async () => {
      const corruptPath = join(tempDir, 'corrupt.db');
      await writeFile(corruptPath, 'not a database');
      const exporter = createExporter(corruptPath);

      const result = await exportSpans(exporter, [createTestSpan()]);

      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(result.error?.message).toContain(
        'Failed to export spans to SQLite',
      );

      // The failed open must not leave the file handle behind: Windows refuses
      // to unlink a file that is still open.
      await exporter.shutdown();
      await expect(rm(corruptPath)).resolves.toBeUndefined();
    });

    it('reopens the database on the next export once the fault is cleared', async () => {
      const corruptPath = join(tempDir, 'retry.db');
      await writeFile(corruptPath, 'not a database');
      const exporter = createExporter(corruptPath);
      const span = createTestSpan({
        attributes: {[SESSION_ID_ATTRIBUTE]: 'session-retry'},
      });

      const failed = await exportSpans(exporter, [span]);
      expect(failed.code).toBe(ExportResultCode.FAILED);

      // Clearing the fault must be enough: a memoized failure would keep
      // reporting FAILED forever.
      await rm(corruptPath);
      const retried = await exportSpans(exporter, [span]);

      expect(retried.code).toBe(ExportResultCode.SUCCESS);
      expect(
        await exporter.getAllSpansForSession('session-retry'),
      ).toHaveLength(1);
    });

    it('reports a failure without logging the span payload that caused it', async () => {
      const strictPath = join(tempDir, 'strict.db');
      const orm = await MikroORM.init({
        dbName: strictPath,
        driver: SqliteDriver,
        entities: [StorageSpan],
      });
      // A NOT NULL column the exporter does not know about makes every insert
      // fail, and safe-mode schema updates never drop it.
      await orm.em
        .getConnection()
        .execute(
          'create table `spans` (`span_id` text not null, `trace_id` text ' +
            'not null, `name` text not null, `extra_required` text not null, ' +
            'primary key (`span_id`))',
        );
      await orm.close();

      const recorder = new RecordingLogger();
      const previousLogger = getLogger();
      setLogger(recorder);
      let result: ExportResult;
      try {
        result = await exportSpans(createExporter(strictPath), [
          createTestSpan({
            attributes: {
              [SESSION_ID_ATTRIBUTE]: 'session-secret',
              'gcp.vertex.agent.llm_request': 'SUPER_SECRET_PROMPT',
            },
          }),
        ]);
      } finally {
        setLogger(previousLogger);
      }

      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(recorder.lines).toEqual([
        'Failed to export spans to SQLite: NotNullConstraintViolationException (SQLITE_CONSTRAINT)',
      ]);
      // OpenTelemetry stringifies every property it can reach on this error,
      // `cause` included, so none of them may carry the attributes.
      expect(result.error?.cause).toBeUndefined();
      for (const property of Object.getOwnPropertyNames(result.error)) {
        expect(
          String(Reflect.get(Object(result.error), property)),
        ).not.toContain('SUPER_SECRET_PROMPT');
      }
    });

    it('initializes once when two exports are issued concurrently', async () => {
      const exporter = createExporter();
      const attributes = {[SESSION_ID_ATTRIBUTE]: 'session-concurrent'};

      const results = await Promise.all([
        exportSpans(exporter, [
          createTestSpan({spanId: '0000000000000001', attributes}),
        ]),
        exportSpans(exporter, [
          createTestSpan({spanId: '0000000000000002', attributes}),
        ]),
      ]);

      expect(results.map((result) => result.code)).toEqual([
        ExportResultCode.SUCCESS,
        ExportResultCode.SUCCESS,
      ]);
      expect(
        await exporter.getAllSpansForSession('session-concurrent'),
      ).toHaveLength(2);
    });
  });

  describe('getAllSpansForSession', () => {
    it('returns only the spans of the requested session', async () => {
      const exporter = createExporter();

      await exportSpans(exporter, [
        createTestSpan({
          spanId: '0000000000000111',
          traceId: '00000000000000000000000000aaa111',
          name: 'span1',
          attributes: {[SESSION_ID_ATTRIBUTE]: 'session-123'},
        }),
        createTestSpan({
          spanId: '0000000000000222',
          traceId: '00000000000000000000000000aaa222',
          name: 'span2',
          attributes: {[SESSION_ID_ATTRIBUTE]: 'session-123'},
        }),
        createTestSpan({
          spanId: '0000000000000333',
          traceId: '00000000000000000000000000bbb333',
          name: 'span3',
          attributes: {[SESSION_ID_ATTRIBUTE]: 'session-456'},
        }),
      ]);

      const names = (await exporter.getAllSpansForSession('session-123')).map(
        (span) => span.name,
      );
      expect(names.sort()).toEqual(['span1', 'span2']);
    });

    it('includes trace siblings that carry no session id', async () => {
      const exporter = createExporter();
      const traceId = '00000000000000000000000000000aaa';

      await exportSpans(exporter, [
        createTestSpan({
          spanId: '0000000000000100',
          traceId,
          name: 'invocation',
        }),
        createTestSpan({
          spanId: '0000000000000200',
          traceId,
          parentSpanId: '0000000000000100',
          name: 'call_llm',
          attributes: {[SESSION_ID_ATTRIBUTE]: 'session-789'},
        }),
        createTestSpan({
          spanId: '0000000000000300',
          traceId,
          parentSpanId: '0000000000000100',
          name: 'tool_call',
        }),
        createTestSpan({
          spanId: '0000000000000400',
          traceId: '00000000000000000000000000000bbb',
          name: 'unrelated',
        }),
      ]);

      const names = (await exporter.getAllSpansForSession('session-789')).map(
        (span) => span.name,
      );
      expect(names.sort()).toEqual(['call_llm', 'invocation', 'tool_call']);
    });

    it('returns an empty array for an unknown session', async () => {
      const exporter = createExporter();

      await exportSpans(exporter, [
        createTestSpan({attributes: {[SESSION_ID_ATTRIBUTE]: 'session-123'}}),
      ]);

      expect(await exporter.getAllSpansForSession('unknown-session')).toEqual(
        [],
      );
    });

    it('preserves name, ids, timestamps and attributes across a round trip', async () => {
      const exporter = createExporter();
      const attributes: Attributes = {
        [SESSION_ID_ATTRIBUTE]: 'session-123',
        'gcp.vertex.agent.invocation_id': 'invocation-456',
        [CONVERSATION_ID_ATTRIBUTE]: 'conv-789',
        'custom.attribute': 'test_value',
        'numeric.value': 42,
        'boolean.value': true,
        'list.value': ['a', 'b'],
      };

      await exportSpans(exporter, [
        createTestSpan({
          spanId: '0000000012345678',
          traceId: '0000000000000000000abcdef1234567',
          name: 'test_operation',
          attributes,
          startTime: [1, 500],
          endTime: [2, 750],
        }),
      ]);

      const [retrieved] = await exporter.getAllSpansForSession('session-123');
      expect(retrieved.name).toBe('test_operation');
      expect(retrieved.spanContext().spanId).toBe('0000000012345678');
      expect(retrieved.spanContext().traceId).toBe(
        '0000000000000000000abcdef1234567',
      );
      expect(retrieved.startTime).toEqual([1, 500]);
      expect(retrieved.endTime).toEqual([2, 750]);
      expect(retrieved.duration).toEqual([1, 250]);
      expect(retrieved.attributes).toEqual(attributes);
    });

    it('preserves nanosecond precision beyond Number.MAX_SAFE_INTEGER', async () => {
      const exporter = createExporter();
      const startTime: HrTime = [1750000000, 123456789];

      await exportSpans(exporter, [
        createTestSpan({
          attributes: {[SESSION_ID_ATTRIBUTE]: 'session-precise'},
          startTime,
          endTime: [1750000001, 987654321],
        }),
      ]);

      const [retrieved] =
        await exporter.getAllSpansForSession('session-precise');
      expect(retrieved.startTime).toEqual(startTime);
      expect(retrieved.endTime).toEqual([1750000001, 987654321]);
    });

    it('restores the parent span context of a child and leaves a root without one', async () => {
      const exporter = createExporter();
      const traceId = '00000000000000000000000000000123';
      const attributes = {[SESSION_ID_ATTRIBUTE]: 'session-001'};

      await exportSpans(exporter, [
        createTestSpan({
          spanId: '0000000000000aaa',
          traceId,
          name: 'parent',
          attributes,
        }),
        createTestSpan({
          spanId: '0000000000000bbb',
          traceId,
          parentSpanId: '0000000000000aaa',
          name: 'child',
          attributes,
        }),
      ]);

      const retrieved = await exporter.getAllSpansForSession('session-001');
      const child = retrieved.find((span) => span.name === 'child');
      const parent = retrieved.find((span) => span.name === 'parent');
      if (!child || !parent) {
        expect.fail('expected both the parent and the child span');
      }
      expect(child.parentSpanContext?.spanId).toBe('0000000000000aaa');
      expect(child.parentSpanContext?.traceId).toBe(traceId);
      expect(parent.parentSpanContext).toBeUndefined();
    });

    it('orders spans numerically by start time', async () => {
      const exporter = createExporter();
      const attributes = {[SESSION_ID_ATTRIBUTE]: 'session-order'};

      await exportSpans(exporter, [
        createTestSpan({
          spanId: '0000000000000300',
          startTime: [1, 750000000],
          attributes,
        }),
        createTestSpan({
          spanId: '0000000000000100',
          startTime: [0, 999],
          attributes,
        }),
        createTestSpan({
          spanId: '0000000000000200',
          startTime: [1, 0],
          attributes,
        }),
      ]);

      const spanIds = (await exporter.getAllSpansForSession('session-order'))
        .map((span) => span.spanContext().spanId)
        .join(',');
      expect(spanIds).toBe(
        '0000000000000100,0000000000000200,0000000000000300',
      );
    });

    it('tolerates a row written without timestamps or valid attributes', async () => {
      const traceId = '000000000000000000000000000000ff';
      const exporter = createExporter();
      await exportSpans(exporter, [
        createTestSpan({
          traceId,
          attributes: {[SESSION_ID_ATTRIBUTE]: 'session-raw'},
        }),
      ]);
      await exporter.shutdown();

      const orm = await MikroORM.init({
        dbName: dbPath,
        driver: SqliteDriver,
        entities: [StorageSpan],
      });
      const em = orm.em.fork();
      em.create(StorageSpan, {
        spanId: '00000000000000ff',
        traceId,
        name: '',
        sessionId: 'session-raw',
        attributesJson: 'not valid json',
      });
      await em.flush();
      await orm.close();

      const retrieved = await exporter.getAllSpansForSession('session-raw');
      const raw = retrieved.find(
        (span) => span.spanContext().spanId === '00000000000000ff',
      );
      if (!raw) {
        expect.fail('expected the externally written row to be returned');
      }
      expect(retrieved[0]).toBe(raw);
      expect(raw.name).toBe('');
      expect(raw.startTime).toEqual([0, 0]);
      expect(raw.endTime).toEqual([0, 0]);
      expect(raw.duration).toEqual([0, 0]);
      expect(raw.attributes).toEqual({});
    });

    it('reads spans written by a previous exporter on the same file', async () => {
      const first = createExporter();
      await exportSpans(first, [
        createTestSpan({
          name: 'persisted',
          attributes: {[SESSION_ID_ATTRIBUTE]: 'session-restart'},
        }),
      ]);
      await first.shutdown();

      const second = createExporter();
      const retrieved = await second.getAllSpansForSession('session-restart');
      expect(retrieved.map((span) => span.name)).toEqual(['persisted']);
    });
  });

  describe('lifecycle', () => {
    it('resolves forceFlush', async () => {
      await expect(createExporter().forceFlush()).resolves.toBeUndefined();
    });

    it('reopens the database after shutdown and tolerates a second shutdown', async () => {
      const exporter = createExporter();
      await exportSpans(exporter, [
        createTestSpan({
          name: 'before_shutdown',
          attributes: {[SESSION_ID_ATTRIBUTE]: 'session-shutdown'},
        }),
      ]);

      await exporter.shutdown();
      await expect(exporter.shutdown()).resolves.toBeUndefined();

      const retrieved =
        await exporter.getAllSpansForSession('session-shutdown');
      expect(retrieved.map((span) => span.name)).toEqual(['before_shutdown']);
    });

    it('releases the connection when shutdown races an in-flight open', async () => {
      const exporter = createExporter();

      const pendingExport = exportSpans(exporter, [
        createTestSpan({attributes: {[SESSION_ID_ATTRIBUTE]: 'session-race'}}),
      ]);
      await exporter.shutdown();
      await pendingExport;

      // Whether that export landed is a race and not the point; the handle
      // being released is. Windows refuses to unlink a file that is still open.
      await expect(rm(dbPath, {force: true})).resolves.toBeUndefined();
    });

    it('does not reject when shutdown races an open that fails', async () => {
      const corruptPath = join(tempDir, 'racing.db');
      await writeFile(corruptPath, 'not a database');
      const exporter = createExporter(corruptPath);

      const pendingExport = exportSpans(exporter, [createTestSpan()]);
      await expect(exporter.shutdown()).resolves.toBeUndefined();

      expect((await pendingExport).code).toBe(ExportResultCode.FAILED);
      await expect(rm(corruptPath)).resolves.toBeUndefined();
    });

    it('is a no-op to shut down an exporter that never opened the database', async () => {
      await expect(createExporter().shutdown()).resolves.toBeUndefined();
      expect(existsSync(dbPath)).toBe(false);
    });
  });

  describe('through an OpenTelemetry tracer provider', () => {
    it('persists a real parent and child span exported by a SimpleSpanProcessor', async () => {
      const exporter = createExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const tracer = provider.getTracer('sqlite-span-exporter-test');

      const parent = tracer.startSpan('invocation');
      parent.setAttribute(SESSION_ID_ATTRIBUTE, 'session-otel');
      const child = tracer.startSpan(
        'call_llm',
        undefined,
        trace.setSpan(context.active(), parent),
      );
      child.end();
      parent.end();
      await provider.forceFlush();
      await provider.shutdown();

      const retrieved = await exporter.getAllSpansForSession('session-otel');
      const names = retrieved.map((span) => span.name);
      expect(names.sort()).toEqual(['call_llm', 'invocation']);

      const persistedChild = retrieved.find((span) => span.name === 'call_llm');
      if (!persistedChild) {
        expect.fail('expected the child span to be persisted');
      }
      expect(persistedChild.spanContext().spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(persistedChild.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(persistedChild.parentSpanContext?.spanId).toBe(
        parent.spanContext().spanId,
      );
    });
  });
});

describe('describeError', () => {
  it('names the error and appends a SQLite driver code', () => {
    expect(
      describeError(Object.assign(new Error('x'), {code: 'SQLITE_BUSY'})),
    ).toBe('Error (SQLITE_BUSY)');
  });

  it('keeps an extended SQLite driver code', () => {
    expect(
      describeError(
        Object.assign(new Error('x'), {code: 'SQLITE_CONSTRAINT_NOTNULL'}),
      ),
    ).toBe('Error (SQLITE_CONSTRAINT_NOTNULL)');
  });

  it('omits a code that is not a SQLite driver code', () => {
    expect(describeError(Object.assign(new TypeError('x'), {code: 42}))).toBe(
      'TypeError',
    );
    expect(
      describeError(Object.assign(new Error('x'), {code: 'insert into spans'})),
    ).toBe('Error');
  });

  it('falls back to a name for an error-like object without one', () => {
    expect(describeError({message: 'SUPER_SECRET_PROMPT'})).toBe('Error');
  });

  it('describes a non-object by its type', () => {
    expect(describeError('SUPER_SECRET_PROMPT')).toBe('string');
    expect(describeError(null)).toBe('object');
  });
});
