/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EntityData, MikroORM} from '@mikro-orm/core';
import {
  Attributes,
  AttributeValue,
  HrTime,
  SpanContext,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
} from '@opentelemetry/api';
import {ExportResult, ExportResultCode} from '@opentelemetry/core';
import {emptyResource} from '@opentelemetry/resources';
import {ReadableSpan, SpanExporter} from '@opentelemetry/sdk-trace-base';

import {ensureDatabaseCreated} from '../sessions/db/operations.js';
import {logger} from '../utils/logger.js';
import {version} from '../version.js';
import {StorageSpan} from './db/schema.js';

const SESSION_ID_ATTRIBUTE = 'gcp.vertex.agent.session_id';
const INVOCATION_ID_ATTRIBUTE = 'gcp.vertex.agent.invocation_id';
const CONVERSATION_ID_ATTRIBUTE = 'gen_ai.conversation.id';

const INSTRUMENTATION_SCOPE_NAME = 'gcp.vertex.agent';
const NANOS_PER_SECOND = 1_000_000_000n;
const NOT_SERIALIZABLE = '<not serializable>';

/** Value types `JSON.stringify` cannot represent. */
const UNSUPPORTED_JSON_TYPES: ReadonlySet<string> = new Set([
  'bigint',
  'function',
  'symbol',
]);

/** Converts an OpenTelemetry `HrTime` to epoch nanoseconds. */
export function hrTimeToUnixNanos(hrTime: HrTime): string {
  return (BigInt(hrTime[0]) * NANOS_PER_SECOND + BigInt(hrTime[1])).toString();
}

/** Converts epoch nanoseconds back to an OpenTelemetry `HrTime`. */
export function unixNanosToHrTime(nanos: string): HrTime {
  return nanosToHrTime(BigInt(nanos));
}

function nanosToHrTime(total: bigint): HrTime {
  return [Number(total / NANOS_PER_SECOND), Number(total % NANOS_PER_SECOND)];
}

/**
 * Serializes span attributes to JSON, replacing values JSON cannot represent
 * with `'<not serializable>'` so their siblings still survive.
 *
 * Returns `'{}'` if the whole object cannot be serialized.
 */
export function serializeAttributes(
  attributes: Record<string, unknown>,
): string {
  try {
    return JSON.stringify(attributes, createNotSerializableReplacer());
  } catch (e: unknown) {
    logger.debug('Failed to serialize span attributes:', e);
    return '{}';
  }
}

/**
 * Parses a stored attributes blob back into OpenTelemetry attributes.
 *
 * Never throws: malformed JSON and non-object payloads yield `{}`, and entries
 * whose value is not a legal `AttributeValue` are dropped.
 */
export function deserializeAttributes(
  attributesJson: string | undefined,
): Attributes {
  if (!attributesJson) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(attributesJson);
  } catch (e: unknown) {
    logger.debug('Failed to deserialize span attributes:', e);
    return {};
  }

  if (!isRecord(parsed)) {
    return {};
  }

  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (isAttributeValue(value)) {
      attributes[key] = value;
    }
  }
  return attributes;
}

/**
 * Builds a `JSON.stringify` replacer mapping values JSON cannot represent, and
 * references back to an enclosing value, to `'<not serializable>'`.
 *
 * The replacer tracks the path it is on, so every serialization needs its own.
 */
function createNotSerializableReplacer(): (
  this: unknown,
  key: string,
  value: unknown,
) => unknown {
  const ancestors: unknown[] = [];
  return function replacer(this: unknown, key: string, value: unknown) {
    while (ancestors.length > 0 && ancestors.at(-1) !== this) {
      ancestors.pop();
    }
    if (typeof value !== 'object' || value === null) {
      return UNSUPPORTED_JSON_TYPES.has(typeof value)
        ? NOT_SERIALIZABLE
        : value;
    }
    // Only an enclosing value is a cycle; the same object appearing twice side
    // by side is not.
    if (ancestors.includes(value)) {
      return NOT_SERIALIZABLE;
    }
    ancestors.push(value);
    return value;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAttributePrimitive(
  value: unknown,
): value is string | number | boolean {
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean';
}

function isAttributeValue(value: unknown): value is AttributeValue {
  if (isAttributePrimitive(value)) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  const present = value.filter(
    (entry) => entry !== null && entry !== undefined,
  );
  const [first] = present;
  return present.every(
    (entry) => typeof entry === typeof first && isAttributePrimitive(entry),
  );
}

/** Reads a stored timestamp, treating a missing one as the epoch. */
function toNanos(stored: string | undefined): bigint {
  return BigInt(stored ?? '0');
}

function compareUnixNanos(
  a: string | undefined,
  b: string | undefined,
): number {
  const left = toNanos(a);
  const right = toNanos(b);
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function stringAttribute(
  attributes: Attributes,
  key: string,
): string | undefined {
  const value = attributes[key];
  return typeof value === 'string' ? value : undefined;
}

function toStorageSpanData(span: ReadableSpan): EntityData<StorageSpan> {
  const spanContext = span.spanContext();
  return {
    spanId: spanContext.spanId,
    traceId: spanContext.traceId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    startTimeUnixNano: hrTimeToUnixNanos(span.startTime),
    endTimeUnixNano: hrTimeToUnixNanos(span.endTime),
    sessionId:
      stringAttribute(span.attributes, SESSION_ID_ATTRIBUTE) ??
      stringAttribute(span.attributes, CONVERSATION_ID_ATTRIBUTE),
    invocationId: stringAttribute(span.attributes, INVOCATION_ID_ATTRIBUTE),
    attributesJson: serializeAttributes(span.attributes),
  };
}

function toReadableSpan(row: StorageSpan): ReadableSpan {
  const spanContext: SpanContext = {
    traceId: row.traceId,
    spanId: row.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: false,
  };
  const startNanos = toNanos(row.startTimeUnixNano);
  const endNanos = toNanos(row.endTimeUnixNano);

  return {
    name: row.name,
    kind: SpanKind.INTERNAL,
    spanContext: () => spanContext,
    parentSpanContext: row.parentSpanId
      ? {...spanContext, spanId: row.parentSpanId}
      : undefined,
    startTime: nanosToHrTime(startNanos),
    endTime: nanosToHrTime(endNanos),
    duration: nanosToHrTime(endNanos - startNanos),
    status: {code: SpanStatusCode.UNSET},
    attributes: deserializeAttributes(row.attributesJson),
    links: [],
    events: [],
    ended: true,
    resource: emptyResource(),
    instrumentationScope: {name: INSTRUMENTATION_SCOPE_NAME, version},
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

/** Options for {@link SqliteSpanExporter}. */
export interface SqliteSpanExporterOptions {
  /** Path to the SQLite database file, e.g. `/tmp/adk_traces.db` or `:memory:`. */
  dbPath: string;
}

/**
 * Exports spans to a local SQLite database.
 *
 * This is intended for local development (e.g. `adk web`), where it allows
 * traces for older sessions to be reloaded after a process restart. It is
 * registered through the existing `OTelHooks.spanProcessors` surface:
 *
 * ```ts
 * import {SimpleSpanProcessor} from '@opentelemetry/sdk-trace-base';
 * import {maybeSetOtelProviders, SqliteSpanExporter} from '@google/adk';
 *
 * const exporter = new SqliteSpanExporter({dbPath: '/tmp/adk_traces.db'});
 * maybeSetOtelProviders([{spanProcessors: [new SimpleSpanProcessor(exporter)]}]);
 * ```
 *
 * The `spans` table has no retention policy, so the database file grows with
 * every exported span. Span attributes are written verbatim.
 *
 * Requires the optional `@mikro-orm/sqlite` peer dependency, which is loaded
 * lazily on first use.
 */
export class SqliteSpanExporter implements SpanExporter {
  private readonly dbPath: string;
  private orm?: MikroORM;
  private initPromise?: Promise<MikroORM>;

  constructor(options: SqliteSpanExporterOptions) {
    this.dbPath = options.dbPath;
  }

  /**
   * Writes a batch of finished spans to the database, one row per span id.
   *
   * Never throws: a persistence failure is logged and reported through
   * `resultCallback` as `ExportResultCode.FAILED`, so it cannot break the run
   * being traced.
   */
  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.persist(spans).then(
      () => {
        resultCallback({code: ExportResultCode.SUCCESS});
      },
      (cause: unknown) => {
        const error = new Error(
          `Failed to export spans to SQLite: ${String(cause)}`,
          {cause},
        );
        logger.warn(error.message);
        resultCallback({code: ExportResultCode.FAILED, error});
      },
    );
  }

  /**
   * Returns all spans belonging to a session, oldest first.
   *
   * Trace ids are resolved from the session first, so spans of the same trace
   * that carry no session id of their own (parent and sibling spans) are
   * included too.
   *
   * Unlike {@link export}, database failures reject rather than being reduced
   * to a log line: this is called directly by application code, which needs to
   * see them.
   */
  async getAllSpansForSession(sessionId: string): Promise<ReadableSpan[]> {
    const orm = await this.init();
    const em = orm.em.fork();

    // simplicity: reads the session's own rows in full to collect their trace
    // ids, which re-reads them in the query below. Fine at local-dev volumes;
    // project to `fields: ['traceId']` if a trace ever gets large.
    const sessionSpans = await em.find(StorageSpan, {sessionId});
    const traceIds = [...new Set(sessionSpans.map((span) => span.traceId))];
    if (traceIds.length === 0) {
      return [];
    }

    const rows = await em.find(StorageSpan, {traceId: {$in: traceIds}});
    // Ordering happens here rather than in SQL because the stored nanoseconds
    // are read as text, which would sort lexicographically.
    rows.sort((a, b) =>
      compareUnixNanos(a.startTimeUnixNano, b.startTimeUnixNano),
    );
    return rows.map(toReadableSpan);
  }

  /** Closes the database. A later export transparently reopens it. */
  async shutdown(): Promise<void> {
    const orm = this.orm;
    this.orm = undefined;
    this.initPromise = undefined;
    if (orm) {
      await orm.close();
    }
  }

  /** Resolves immediately: every export has already been committed. */
  async forceFlush(): Promise<void> {}

  private async persist(spans: ReadableSpan[]): Promise<void> {
    if (spans.length === 0) {
      return;
    }

    const orm = await this.init();
    await orm.em.fork().upsertMany(StorageSpan, spans.map(toStorageSpanData));
  }

  private init(): Promise<MikroORM> {
    // A failed open is not memoized, so a later call retries it.
    this.initPromise ??= this.open().catch((error: unknown) => {
      this.initPromise = undefined;
      throw error;
    });
    return this.initPromise;
  }

  private async open(): Promise<MikroORM> {
    const {SqliteDriver} = await import('@mikro-orm/sqlite');
    const orm = await MikroORM.init({
      dbName: this.dbPath,
      driver: SqliteDriver,
      entities: [StorageSpan],
    });
    await ensureDatabaseCreated(orm);
    this.orm = orm;
    return orm;
  }
}
