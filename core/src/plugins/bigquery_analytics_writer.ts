/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BigQueryOptions,
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

/** Returns whether `err` is BigQuery reporting that the table already exists. */
function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as {code?: unknown}).code === ALREADY_EXISTS_STATUS
  );
}

/**
 * Awaits `work`, giving up after `timeoutMs`. The timer is always cleared, so
 * a fast `work` never holds the Node process open.
 */
async function awaitWithTimeout(
  work: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([work, expiry]);
  clearTimeout(timer);
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
 * The dataset must already exist; the writer creates only the table.
 */
export class BigQueryRowWriter {
  private readonly queue: AnalyticsRow[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private readonly drops = new Map<AnalyticsDropReason, number>(
    Object.values(AnalyticsDropReason).map((reason) => [reason, 0]),
  );
  private table?: Table;
  private tablePromise?: Promise<Table>;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlightRows = 0;
  private shutDown = false;

  constructor(private readonly options: BigQueryRowWriterOptions) {}

  /** Fully qualified `project.dataset.table` name, for log messages. */
  get tableName(): string {
    const {projectId, datasetId, tableId} = this.options;
    return `${projectId}.${datasetId}.${tableId}`;
  }

  /** Records one lost or degraded row against `reason`. */
  countDrop(reason: AnalyticsDropReason, rows = 1): void {
    this.drops.set(reason, (this.drops.get(reason) ?? 0) + rows);
  }

  /**
   * Returns the per-reason drop counters. They survive `shutdown()`, so a host
   * can export the loss after the run has finished.
   */
  getDropStats(): Record<string, number> {
    return Object.fromEntries(this.drops);
  }

  /**
   * Queues `row` for the next batch write.
   *
   * @param row The row to write.
   */
  async enqueue(row: AnalyticsRow): Promise<void> {
    const table = await this.openTableOnce();
    if (table === undefined) {
      this.countDrop(AnalyticsDropReason.SETUP_UNAVAILABLE);
      return;
    }
    if (this.queue.length >= this.options.queueMaxSize) {
      this.countDrop(AnalyticsDropReason.QUEUE_FULL);
      logger.warn(
        `BigQuery analytics queue for ${this.tableName} is full; dropping a ` +
          `row. Rows dropped so far: ${this.drops.get(AnalyticsDropReason.QUEUE_FULL)}.`,
      );
      return;
    }
    this.queue.push(row);
    if (this.queue.length >= this.options.batchSize) {
      return this.writeBatch();
    }
    this.startTimer();
  }

  /** Writes everything queued and waits for every in-flight insert to settle. */
  async flush(): Promise<void> {
    await this.writeBatch();
    await Promise.all([...this.inFlight]);
  }

  /**
   * Drains the queue, releases the flush timer, and counts whatever could not
   * be written within the shutdown timeout. Safe to call more than once.
   */
  async shutdown(): Promise<void> {
    if (this.shutDown) {
      return;
    }
    this.shutDown = true;
    this.clearTimer();
    await awaitWithTimeout(this.flush(), this.options.shutdownTimeoutMs);
    const lost = this.queue.length + this.inFlightRows;
    if (lost > 0) {
      this.queue.length = 0;
      this.countDrop(AnalyticsDropReason.SHUTDOWN_TIMEOUT, lost);
      logger.warn(
        `BigQuery analytics shutdown timed out after ` +
          `${this.options.shutdownTimeoutMs}ms; ${lost} row(s) for ` +
          `${this.tableName} were not written.`,
      );
    }
  }

  /**
   * Resolves the table handle, opening the client and creating the table on
   * first use. Returns `undefined` when setup failed, having logged the cause;
   * the next call retries, so a transient control-plane failure does not
   * disable the plugin for the rest of the process.
   */
  private async openTableOnce(): Promise<Table | undefined> {
    if (this.table !== undefined) {
      return this.table;
    }
    const pending = (this.tablePromise ??= this.openTable());
    try {
      this.table = await pending;
      return this.table;
    } catch (err: unknown) {
      if (this.tablePromise === pending) {
        this.tablePromise = undefined;
        logger.error(
          `BigQuery analytics could not open ${this.tableName}: ${formatError(err)}`,
        );
      }
      return undefined;
    }
  }

  /** Loads the optional peer, then finds or creates the events table. */
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

  /** Hands every queued row to BigQuery as one insert. */
  private async writeBatch(): Promise<void> {
    const table = this.table;
    if (table === undefined || this.queue.length === 0) {
      return;
    }
    const rows = this.queue.splice(0, this.queue.length);
    this.clearTimer();
    this.inFlightRows += rows.length;
    const write = this.insert(table, rows).finally(() => {
      this.inFlightRows -= rows.length;
      this.inFlight.delete(write);
    });
    this.inFlight.add(write);
    await write;
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
      this.countDrop(AnalyticsDropReason.WRITE_FAILED, rows.length);
      logger.warn(
        `BigQuery analytics dropped ${rows.length} row(s) for ` +
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
      void this.writeBatch();
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
