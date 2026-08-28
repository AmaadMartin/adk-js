/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BigQueryOptions,
  Dataset,
  Table,
  TableMetadata,
} from '@google-cloud/bigquery';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';
import {
  AnalyticsRow,
  EVENTS_TABLE_SCHEMA,
  SCHEMA_VERSION,
  SCHEMA_VERSION_LABEL_KEY,
} from './bigquery_analytics_schema.js';

/** HTTP status BigQuery returns when a table already exists. */
const ALREADY_EXISTS_STATUS = 409;

/**
 * The error name the BigQuery client uses when an insert accepted some rows
 * and rejected others.
 */
const PARTIAL_FAILURE_ERROR_NAME = 'PartialFailureError';

/** Delay before the first retry of a failed setup. */
const SETUP_RETRY_BASE_MS = 1000;

/** Longest delay between setup retries. */
const SETUP_RETRY_MAX_MS = 60_000;

/** Why a row never reached the events table, or lost its payload on the way. */
export enum AnalyticsDropReason {
  /** The in-memory queue was full when the row arrived. */
  QUEUE_FULL = 'queue_full',
  /** BigQuery rejected the batch. */
  WRITE_FAILED = 'write_failed',
  /** The row was still pending when the shutdown timeout expired. */
  SHUTDOWN_TIMEOUT = 'shutdown_timeout',
  /** The client or the table could not be opened. */
  SETUP_UNAVAILABLE = 'setup_unavailable',
  /** The configured content formatter failed, so the row carries a sentinel. */
  FORMATTER_FAILED = 'formatter_failed',
  /** The content could not be sanitized, so the row carries a sentinel. */
  CONTENT_PARSE_FAILED = 'content_parse_failed',
}

/** Everything {@link BigQueryRowWriter} needs to open and feed the table. */
export interface BigQueryRowWriterOptions {
  projectId: string;
  datasetId: string;
  tableId: string;
  location: string;
  clusteringFields: string[];
  batchSize: number;
  flushIntervalMs: number;
  shutdownTimeoutMs: number;
  queueMaxSize: number;
}

/**
 * Finds or creates `dataset`. A create that loses the race to a concurrent
 * writer is treated as success, the same way the table path treats it.
 */
async function ensureDataset(
  dataset: Dataset,
  location: string,
): Promise<void> {
  const [exists] = await dataset.exists();
  if (exists) {
    return;
  }
  try {
    await dataset.create({location});
    logger.debug(`BigQuery analytics created dataset ${dataset.id}.`);
  } catch (err: unknown) {
    if (!isAlreadyExists(err)) {
      throw err;
    }
  }
}

/** Returns whether `err` is BigQuery reporting that the resource already exists. */
function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as {code?: unknown}).code === ALREADY_EXISTS_STATUS
  );
}

/**
 * Awaits `work`, giving up after `timeoutMs`. The timer is cleared on every
 * exit path, so a fast or failing `work` never holds the Node process open.
 */
async function awaitWithTimeout(
  work: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many rows of a batch of `batchSize` an insert failure lost.
 *
 * `tabledata.insertAll` can accept part of a batch and reject the rest, which
 * the client reports as a `PartialFailureError` carrying one entry per rejected
 * row. Charging the whole batch there would report rows that landed as lost.
 *
 * @param err The error the insert threw.
 * @param batchSize How many rows the insert carried.
 * @return The number of rows that did not land.
 */
function rejectedRowCount(err: unknown, batchSize: number): number {
  if (typeof err !== 'object' || err === null) {
    return batchSize;
  }
  const {name, errors} = err as {name?: unknown; errors?: unknown};
  if (name !== PARTIAL_FAILURE_ERROR_NAME || !Array.isArray(errors)) {
    return batchSize;
  }
  return Math.min(errors.length, batchSize);
}

/**
 * Owns the BigQuery client, the pending-row queue and the flush timer for one
 * events table.
 *
 * Rows are appended with `enqueue()` and written in batches, either when the
 * batch fills or when the flush timer fires. Nothing here ever throws at the
 * caller: a failure is counted in {@link getDropStats} and logged, because the
 * caller is an agent callback and analytics must not break an agent run.
 *
 * The writer creates the dataset and the table if they are absent.
 *
 * Transport: adk-python appends rows through the BigQuery Storage Write API.
 * This writer calls `table.insert()`, which is `tabledata.insertAll`. That is a
 * deliberate departure, not an oversight. Both paths write the same columns and
 * the same values, so one dataset answers queries from either SDK.
 *
 * The delivery semantics differ, and a host that reads {@link getDropStats}
 * should know how. `insertAll` de-duplicates on the insert id of a row on a
 * best-effort basis, where adk-python's committed streams and offsets can
 * de-duplicate exactly. BigQuery also rejects an insert into a table it created
 * moments earlier, until that new table propagates, so the first rows written
 * to a fresh table can be lost. Such a row is counted under
 * {@link AnalyticsDropReason.WRITE_FAILED} rather than retried, because a retry
 * loop here would hold an agent run open on the error path.
 */
export class BigQueryRowWriter {
  private readonly queue: AnalyticsRow[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly drops: Record<AnalyticsDropReason, number> = {
    [AnalyticsDropReason.QUEUE_FULL]: 0,
    [AnalyticsDropReason.WRITE_FAILED]: 0,
    [AnalyticsDropReason.SHUTDOWN_TIMEOUT]: 0,
    [AnalyticsDropReason.SETUP_UNAVAILABLE]: 0,
    [AnalyticsDropReason.FORMATTER_FAILED]: 0,
    [AnalyticsDropReason.CONTENT_PARSE_FAILED]: 0,
  };
  private tablePromise?: Promise<Table>;
  private timer?: ReturnType<typeof setTimeout>;
  private pendingRows = 0;
  private setupFailures = 0;
  private nextSetupAttemptMs = 0;
  private abandoned = false;

  constructor(private readonly options: BigQueryRowWriterOptions) {}

  /** Fully qualified `project.dataset.table` name, for log messages. */
  get tableName(): string {
    const {projectId, datasetId, tableId} = this.options;
    return `${projectId}.${datasetId}.${tableId}`;
  }

  /**
   * Records one lost or degraded row against `reason`.
   *
   * Counting stops once shutdown gives up on an insert: shutdown has already
   * charged those rows, and the abandoned insert settles afterwards, so
   * counting again would report the same row twice under two reasons.
   */
  countDrop(reason: AnalyticsDropReason, rows = 1): void {
    if (this.abandoned) {
      return;
    }
    this.drops[reason] += rows;
  }

  /**
   * Returns the per-reason drop counters. They survive `shutdown()`, so a host
   * can export the loss after the run has finished.
   */
  getDropStats(): Record<string, number> {
    return {...this.drops};
  }

  /**
   * Queues `row` for the next batch write and returns at once.
   *
   * The caller is an agent callback, so nothing here waits on the network: a
   * full batch starts a write that {@link flush} and {@link shutdown} join
   * later. Opening the client and the table happens on that write too, not
   * here.
   *
   * @param row The row to write.
   */
  enqueue(row: AnalyticsRow): void {
    if (this.queue.length >= this.options.queueMaxSize) {
      this.countDrop(AnalyticsDropReason.QUEUE_FULL);
      logger.warn(
        `BigQuery analytics queue for ${this.tableName} is full; dropping a ` +
          `row. Rows dropped so far: ${this.drops[AnalyticsDropReason.QUEUE_FULL]}.`,
      );
      return;
    }
    this.queue.push(row);
    if (this.queue.length >= this.options.batchSize) {
      this.startWrite();
      return;
    }
    this.startTimer();
  }

  /** Writes everything queued and waits for every in-flight insert to settle. */
  async flush(): Promise<void> {
    this.startWrite();
    await Promise.all([...this.inFlight]);
  }

  /**
   * Writes everything queued, giving up the wait after the shutdown timeout.
   *
   * A run ends with this, so a BigQuery call that hangs rather than fails
   * delays the run by a bounded time. Nothing is dropped: the insert keeps
   * running and the next flush waits for it again.
   */
  async flushWithinTimeout(): Promise<void> {
    return awaitWithTimeout(this.flush(), this.options.shutdownTimeoutMs);
  }

  /**
   * Drains the queue, releases the flush timer, and counts whatever could not
   * be written within the shutdown timeout. The owning plugin is what makes
   * shutting down idempotent, so this runs once per process.
   */
  async shutdown(): Promise<void> {
    this.clearTimer();
    await this.flushWithinTimeout();
    const lost = this.queue.length + this.pendingRows;
    if (lost > 0) {
      this.queue.length = 0;
      this.countDrop(AnalyticsDropReason.SHUTDOWN_TIMEOUT, lost);
      this.abandoned = true;
      logger.warn(
        `BigQuery analytics shutdown timed out after ` +
          `${this.options.shutdownTimeoutMs}ms; ${lost} row(s) for ` +
          `${this.tableName} were not written.`,
      );
    }
  }

  /**
   * Resolves the table handle, opening the client and creating the table on
   * first use. The promise is kept, so later writes reuse the same handle.
   * Returns `undefined` when setup failed, having logged the cause; the next
   * call retries, so a transient control-plane failure does not disable the
   * plugin for the rest of the process.
   */
  private async openTableOnce(): Promise<Table | undefined> {
    if (Date.now() < this.nextSetupAttemptMs) {
      return undefined;
    }
    const pending = (this.tablePromise ??= this.openTable());
    try {
      return await pending;
    } catch (err: unknown) {
      if (this.tablePromise === pending) {
        this.tablePromise = undefined;
        this.setupFailures += 1;
        this.nextSetupAttemptMs = Date.now() + this.setupRetryDelayMs();
        logger.error(
          `BigQuery analytics could not open ${this.tableName}: ${formatError(err)}`,
        );
      }
      return undefined;
    }
  }

  /**
   * How long to wait before attempting setup again. The delay doubles with
   * each failure up to a cap, so an unreachable BigQuery is retried without
   * one failing round-trip per batch for the life of the process.
   */
  private setupRetryDelayMs(): number {
    return Math.min(
      SETUP_RETRY_BASE_MS * 2 ** (this.setupFailures - 1),
      SETUP_RETRY_MAX_MS,
    );
  }

  /**
   * Loads the optional peer, then finds or creates the dataset and the events
   * table.
   */
  private async openTable(): Promise<Table> {
    const {projectId, datasetId, tableId, location, clusteringFields} =
      this.options;
    const {BigQuery} = await loadOptionalPeer(
      {
        packageName: '@google-cloud/bigquery',
        feature: 'BigQueryAgentAnalyticsPlugin',
      },
      () => import('@google-cloud/bigquery'),
    );
    const clientOptions: BigQueryOptions = {projectId, location};
    const dataset = new BigQuery(clientOptions).dataset(datasetId);
    await ensureDataset(dataset, location);
    const table = dataset.table(tableId);
    const [exists] = await table.exists();
    if (exists) {
      return table;
    }
    const metadata: TableMetadata = {
      schema: EVENTS_TABLE_SCHEMA,
      timePartitioning: {type: 'DAY', field: 'timestamp'},
      clustering: {fields: clusteringFields},
      labels: {[SCHEMA_VERSION_LABEL_KEY]: SCHEMA_VERSION},
      location,
    };
    try {
      const [created] = await dataset.createTable(tableId, metadata);
      logger.debug(`BigQuery analytics created table ${this.tableName}.`);
      return created;
    } catch (err: unknown) {
      if (!isAlreadyExists(err)) {
        throw err;
      }
      const [concurrent] = await table.get();
      return concurrent;
    }
  }

  /**
   * Starts a batch write and tracks it, without waiting for it. Nothing inside
   * {@link writeBatch} throws, so the untracked rejection this would otherwise
   * risk cannot happen.
   */
  private startWrite(): void {
    if (this.queue.length === 0) {
      return;
    }
    const write = this.writeBatch().finally(() => {
      this.inFlight.delete(write);
    });
    this.inFlight.add(write);
  }

  /** Opens the table if needed, then hands every queued row to it as one insert. */
  private async writeBatch(): Promise<void> {
    const rows = this.queue.splice(0, this.queue.length);
    this.clearTimer();
    this.pendingRows += rows.length;
    try {
      const table = await this.openTableOnce();
      if (table === undefined) {
        this.countDrop(AnalyticsDropReason.SETUP_UNAVAILABLE, rows.length);
        return;
      }
      await this.insert(table, rows);
    } finally {
      this.pendingRows -= rows.length;
    }
  }

  /**
   * Inserts one batch. `insertId` is the row's `event_id`, which gives
   * best-effort de-duplication over the same key adk-python uses.
   */
  private async insert(table: Table, rows: AnalyticsRow[]): Promise<void> {
    try {
      await table.insert(
        rows.map((row) => ({insertId: row.event_id, json: row})),
        {raw: true},
      );
    } catch (err: unknown) {
      const lost = rejectedRowCount(err, rows.length);
      this.countDrop(AnalyticsDropReason.WRITE_FAILED, lost);
      logger.warn(
        `BigQuery analytics dropped ${lost} of ${rows.length} row(s) for ` +
          `${this.tableName}: ${formatError(err)}`,
      );
    }
  }

  /** Arms the flush timer, unless one is already armed. */
  private startTimer(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startWrite();
    }, this.options.flushIntervalMs);
    // A pending flush must never be the reason a process stays alive.
    this.timer.unref();
  }

  /** Disarms the flush timer. */
  private clearTimer(): void {
    if (this.timer === undefined) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
