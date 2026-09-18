/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

import type {MikroORM as MikroORMClass} from '@mikro-orm/core';
import {ExportResult, ExportResultCode} from '@opentelemetry/core';
import {ReadableSpan, SpanExporter} from '@opentelemetry/sdk-trace-base';

import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';
import {
  compareByStartTime,
  toReadableSpan,
  toStorageSpanData,
} from './db/span_mapper.js';

type SchemaModule = typeof import('./db/schema.js');
type OperationsModule = typeof import('../sessions/db/operations.js');

let MikroORM: typeof MikroORMClass;
let StorageSpan: SchemaModule['StorageSpan'];
let storageSpanSchema: SchemaModule['storageSpanSchema'];
let ensureDatabaseCreated: OperationsModule['ensureDatabaseCreated'];

let mikroOrmLoad: Promise<void> | undefined;

/**
 * Resolves (and memoizes) MikroORM plus the ADK database modules.
 *
 * These stay off the static import graph so that `@mikro-orm/core` is not
 * evaluated when an agent imports `@google/adk` and never persists a span.
 * A rejected promise stays cached, so a broken install keeps producing the
 * same error instead of retrying module resolution on every call.
 */
function loadMikroOrm(): Promise<void> {
  mikroOrmLoad ??= importMikroOrm();
  return mikroOrmLoad;
}

async function importMikroOrm(): Promise<void> {
  const [core, schema, operations] = await Promise.all([
    import('@mikro-orm/core'),
    import('./db/schema.js'),
    import('../sessions/db/operations.js'),
  ]);

  ({MikroORM} = core);
  ({StorageSpan, storageSpanSchema} = schema);
  ({ensureDatabaseCreated} = operations);
}

/** How long SQLite waits out a contended write, matching the reference. */
const BUSY_TIMEOUT_MS = 30_000;

/** SQLite driver error codes, e.g. `SQLITE_BUSY` or `SQLITE_IOERR_READ`. */
const SQLITE_ERROR_CODE = /^SQLITE_[A-Z_]+$/;

/**
 * Names a failure without echoing what caused it.
 *
 * Driver errors inline the failing statement together with its bound values,
 * and span attributes carry serialized LLM requests and responses by default
 * (`ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS`), so neither the driver message nor
 * the original error may escape: OpenTelemetry's global error handler
 * stringifies every property it can reach on an `ExportResult.error`,
 * including `cause`.
 */
export function describeError(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null) {
    return typeof cause;
  }
  const name =
    'name' in cause && typeof cause.name === 'string' ? cause.name : 'Error';
  if (
    'code' in cause &&
    typeof cause.code === 'string' &&
    SQLITE_ERROR_CODE.test(cause.code)
  ) {
    return `${name} (${cause.code})`;
  }
  return name;
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
  private initPromise?: Promise<MikroORMClass>;

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
          `Failed to export spans to SQLite: ${describeError(cause)}`,
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

    const sessionSpans = await em.find(
      StorageSpan,
      {sessionId},
      {fields: ['traceId']},
    );
    const traceIds = [...new Set(sessionSpans.map((span) => span.traceId))];
    if (traceIds.length === 0) {
      return [];
    }

    const rows = await em.find(StorageSpan, {traceId: {$in: traceIds}});
    // Ordering happens here rather than in SQL because the stored nanoseconds
    // are read as text, which would sort lexicographically.
    return rows.sort(compareByStartTime).map(toReadableSpan);
  }

  /** Closes the database. A later export transparently reopens it. */
  async shutdown(): Promise<void> {
    const pending = this.initPromise;
    this.initPromise = undefined;
    // Awaiting the in-flight open is what stops a shutdown issued mid-export
    // from orphaning the connection it is still creating. An open that failed
    // has already closed itself.
    const orm = await pending?.catch(() => undefined);
    await orm?.close();
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

  private init(): Promise<MikroORMClass> {
    // A failed open is not memoized, so a later call retries it.
    this.initPromise ??= this.open().catch((error: unknown) => {
      this.initPromise = undefined;
      throw error;
    });
    return this.initPromise;
  }

  private async open(): Promise<MikroORMClass> {
    // Load MikroORM and the ADK database modules lazily, so importing
    // `@google/adk` never evaluates `@mikro-orm/core`. See {@link loadMikroOrm}.
    await loadMikroOrm();
    const {SqliteDriver} = await loadOptionalPeer(
      {packageName: '@mikro-orm/sqlite', feature: 'SqliteSpanExporter'},
      () => import('@mikro-orm/sqlite'),
    );
    // The v7 driver opens the file through better-sqlite3, which throws rather
    // than create a missing parent directory. Create it first so a fresh path
    // like `traces/run-1/spans.db` works on first use. `:memory:` has no path.
    if (this.dbPath !== ':memory:') {
      await mkdir(dirname(this.dbPath), {recursive: true});
    }
    // MikroORM v7 `init` loads metadata without opening the connection, so the
    // file is opened only by the explicit `connect` below. A failure there is
    // caught and the handle is closed, so the file is never leaked. Windows
    // would otherwise refuse to delete a file left open by a throwing `init`.
    const orm = await MikroORM.init({
      dbName: this.dbPath,
      driver: SqliteDriver,
      entities: [storageSpanSchema],
    });
    try {
      await orm.connect();
      // Parity with the reference exporter's 30s sqlite3 connect timeout: wait
      // out a contended write rather than dropping the batch. Contention is
      // realistic because the file may be shared with DatabaseSessionService.
      await orm.em
        .getConnection()
        .execute(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`);
      await ensureDatabaseCreated(orm);
    } catch (error: unknown) {
      await orm.close();
      throw error;
    }
    return orm;
  }
}
