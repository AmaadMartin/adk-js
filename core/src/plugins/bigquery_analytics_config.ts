/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {NO_LENGTH_LIMIT} from '../utils/sanitize_utils.js';
import {
  AnalyticsEventType,
  AnalyticsPayloadColumn,
  validatePayloadColumnDenylist,
} from './bigquery_analytics_schema.js';
import type {
  BigQueryCredentials,
  BigQueryRowWriterOptions,
} from './bigquery_analytics_writer.js';

/** Default configuration values, matching adk-python's `BigQueryLoggerConfig`. */
const DEFAULT_TABLE_ID = 'agent_events';
const DEFAULT_LOCATION = 'US';
const DEFAULT_MAX_CONTENT_LENGTH = 500 * 1024;
const DEFAULT_CLUSTERING_FIELDS = ['event_type', 'agent', 'user_id'];
const DEFAULT_BATCH_SIZE = 1;
const DEFAULT_BATCH_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_QUEUE_MAX_SIZE = 10000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_MULTIPLIER = 2;
const DEFAULT_MAX_DELAY_MS = 10000;
const DEFAULT_VIEW_PREFIX = 'v';

/** Suffix marking an allowlist entry as a prefix pattern rather than a key. */
const PREFIX_WILDCARD = '*';

/** Turns a payload into the value written to the `content` column. */
export type AnalyticsContentFormatter = (
  content: unknown,
  eventType: string,
) => unknown;

/**
 * How a failed insert is retried.
 *
 * The delays are milliseconds, like every other duration in this
 * configuration. adk-python's `RetryConfig` counts float seconds, so its
 * `initial_delay: 1.0` is `initialDelayMs: 1000` here. The type carries an
 * `Analytics` prefix because `RetryConfig` is already the workflow retry type.
 */
export interface AnalyticsRetryConfig {
  /** Retries after the first attempt. Defaults to 3, so 4 attempts in all. */
  maxRetries?: number;
  /** Milliseconds before the first retry. Defaults to 1000. */
  initialDelayMs?: number;
  /** Factor the delay grows by after each retry. Defaults to 2. */
  multiplier?: number;
  /** Longest delay between retries, in milliseconds. Defaults to 10000. */
  maxDelayMs?: number;
}

/** {@link AnalyticsRetryConfig} with every default filled in. */
export interface ResolvedAnalyticsRetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
}

/** The `custom_metadata` keys to capture, split into the two match kinds. */
export interface CustomMetadataAllowlist {
  /** Keys that match in full. */
  exact: ReadonlySet<string>;
  /** Prefixes from entries written with a trailing `*`. */
  prefixes: readonly string[];
}

/**
 * Tuning for `BigQueryAgentAnalyticsPlugin`.
 *
 * Every field is optional and falls back to the same default adk-python uses.
 * The duration fields carry an `Ms` suffix and take milliseconds, where Python
 * takes float seconds.
 */
export interface BigQueryLoggerConfig {
  /** Whether the plugin writes anything at all. Defaults to true. */
  enabled?: boolean;
  /** When set, only these event types are written. */
  eventAllowlist?: AnalyticsEventType[];
  /** Event types that are never written. Applied before the allowlist. */
  eventDenylist?: AnalyticsEventType[];
  /** Maximum length of a captured string, or -1 for no limit. */
  maxContentLength?: number;
  /**
   * The events table. Defaults to `agent_events`. The constructor's own
   * `tableId` option wins over this one, matching adk-python.
   */
  tableId?: string;
  /** Columns the events table is clustered by. */
  clusteringFields?: string[];
  /** Whether the `content_parts` column is populated. Defaults to true. */
  logMultiModalContent?: boolean;
  /** Rows per insert. Defaults to 1, which writes each row as it is produced. */
  batchSize?: number;
  /** How long a partial batch waits before it is written. */
  batchFlushIntervalMs?: number;
  /** How long `shutdown()` waits for the queue to drain. */
  shutdownTimeoutMs?: number;
  /** Rows held in memory before new ones are dropped. */
  queueMaxSize?: number;
  /** Replaces the captured payload before it is written. */
  contentFormatter?: AnalyticsContentFormatter;
  /** Whether `attributes.session_metadata` is written. Defaults to true. */
  logSessionMetadata?: boolean;
  /** Static tags copied into `attributes.custom_tags` on every row. */
  customTags?: Record<string, unknown>;
  /**
   * Tools that deliver the agent's final answer. Completing one of these also
   * writes an `AGENT_RESPONSE` row carrying the call arguments. Empty by
   * default.
   */
  finalResponseToolNames?: readonly string[];
  /** Whether each run ends with a flush. Defaults to true. */
  flushOnRunEnd?: boolean;
  /**
   * Whether each row captures the ambient OpenTelemetry span into
   * `attributes.otel`, to join against a Cloud Trace export. Defaults to
   * false. The plugin opens no span of its own.
   */
  enableOtelCorrelation?: boolean;
  /** How a failed insert is retried. Defaults to {@link AnalyticsRetryConfig}'s own defaults. */
  retryConfig?: AnalyticsRetryConfig;
  /**
   * Whether an existing table gains the columns this schema version adds.
   * Additive only: nothing is dropped, retyped or reordered. Defaults to true.
   */
  autoSchemaUpgrade?: boolean;
  /**
   * The `event.customMetadata` keys copied into `attributes.custom_metadata`.
   * An entry ending in `*` matches by prefix; every other entry matches in
   * full. Nothing is captured by default.
   */
  customMetadataAllowlist?: readonly string[];
  /**
   * Columns to leave out of the table and out of every row. Only `content`,
   * `content_parts`, `attributes` and `latency_ms` may be listed; any other
   * name throws at construction.
   */
  payloadColumnDenylist?: readonly string[];
  /**
   * Whether one flattened view per event type is created alongside the table.
   * Defaults to true.
   */
  createViews?: boolean;
  /**
   * The prefix each view's name starts with, so the view of `TOOL_COMPLETED`
   * is `v_tool_completed`. Defaults to `v`. An empty prefix throws.
   */
  viewPrefix?: string;
  /**
   * The Cloud Storage bucket that receives content too large to inline. When
   * this is set, a binary part and an oversized text part are uploaded and the
   * row carries a `gs://` URI instead of the bytes. The plugin does not create
   * the bucket. Nothing is offloaded when this is omitted.
   */
  gcsBucketName?: string;
  /**
   * The BigQuery connection authorizing reads of the offloaded objects,
   * written `location.connection_id`. It is recorded on each `object_ref` and
   * is only read on the offload path, so it does nothing without
   * {@link BigQueryLoggerConfig.gcsBucketName}.
   */
  connectionId?: string;
}

/** Constructor parameters for `BigQueryAgentAnalyticsPlugin`. */
export interface BigQueryAgentAnalyticsPluginOptions {
  /** The Google Cloud project holding the dataset. */
  projectId: string;
  /** The dataset holding the events table. Created on first use. */
  datasetId: string;
  /** The events table. Created on first use. Defaults to `agent_events`. */
  tableId?: string;
  /** BigQuery location for the client and the created table. Defaults to `US`. */
  location?: string;
  /**
   * Credentials for the BigQuery client. Application Default Credentials are
   * used when this is omitted.
   */
  credentials?: BigQueryCredentials;
  /** Tuning, all of it optional. */
  config?: BigQueryLoggerConfig;
}

/** {@link BigQueryLoggerConfig} with every default filled in. */
export interface ResolvedConfig {
  enabled: boolean;
  eventAllowlist?: AnalyticsEventType[];
  eventDenylist?: AnalyticsEventType[];
  maxContentLength: number;
  logMultiModalContent: boolean;
  contentFormatter?: AnalyticsContentFormatter;
  logSessionMetadata: boolean;
  customTags: Record<string, unknown>;
  finalResponseToolNames: readonly string[];
  flushOnRunEnd: boolean;
  enableOtelCorrelation: boolean;
  /** Pre-parsed, so matching one key costs no reparsing on the hot path. */
  customMetadataAllowlist: CustomMetadataAllowlist;
  deniedColumns: ReadonlySet<AnalyticsPayloadColumn>;
  gcsBucketName?: string;
  connectionId?: string;
}

/** Prefixes every configuration error with the option's owner. */
function configError(message: string): InputValidationError {
  return new InputValidationError(`BigQueryAgentAnalyticsPlugin: ${message}`);
}

/**
 * Rejects a value that is not an integer of at least `minimum`. `undefined`
 * passes, because the caller then takes the default.
 */
function requireCount(
  name: string,
  value: number | undefined,
  minimum: number,
): void {
  if (value !== undefined && (!Number.isInteger(value) || value < minimum)) {
    throw configError(
      `${name} must be an integer of at least ${minimum}, got ${String(value)}.`,
    );
  }
}

/**
 * Rejects a value that is not a finite number of at least `minimum`.
 *
 * The finiteness test is the load-bearing half. `NaN < minimum` is false, so
 * an ordered comparison on its own lets `NaN` through every range check and
 * the option reaches the writer as a delay nothing ever waits out.
 */
function requireFinite(
  name: string,
  value: number | undefined,
  minimum: number,
): void {
  if (value !== undefined && (!Number.isFinite(value) || value < minimum)) {
    throw configError(
      `${name} must be a finite number of at least ${minimum}, got ` +
        `${String(value)}.`,
    );
  }
}

/** Rejects a value that is not a finite number greater than zero. */
function requireFiniteAboveZero(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw configError(
      `${name} must be a finite number greater than 0, got ${String(value)}.`,
    );
  }
}

/** Rejects a content limit that is neither unlimited nor a usable length. */
function requireContentLimit(limit: number | undefined): void {
  if (
    limit !== undefined &&
    limit !== NO_LENGTH_LIMIT &&
    (!Number.isInteger(limit) || limit < 1)
  ) {
    throw configError(
      `maxContentLength must be an integer of at least 1, or ` +
        `${NO_LENGTH_LIMIT} for no limit, got ${String(limit)}.`,
    );
  }
}

/**
 * Rejects a retry configuration that cannot produce a working backoff.
 *
 * A zero delay is allowed: an immediate retry is a supported configuration and
 * `maxRetries: 0, initialDelay: 0, maxDelay: 0` turns retrying off outright.
 */
function requireRetryConfig(retry: AnalyticsRetryConfig): void {
  requireCount('retryConfig.maxRetries', retry.maxRetries, 0);
  requireFinite('retryConfig.initialDelayMs', retry.initialDelayMs, 0);
  requireFinite('retryConfig.multiplier', retry.multiplier, 1);
  requireFinite('retryConfig.maxDelayMs', retry.maxDelayMs, 0);
  const initialDelayMs = retry.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  if (maxDelayMs < initialDelayMs) {
    throw configError(
      `retryConfig.maxDelayMs must be at least retryConfig.initialDelayMs, ` +
        `got maxDelayMs=${maxDelayMs} initialDelayMs=${initialDelayMs}.`,
    );
  }
}

/** Rejects a blank string. */
function requireNonEmpty(name: string, value: string): void {
  if (value.trim() === '') {
    throw configError(`${name} must not be empty.`);
  }
}

/** Rejects an empty optional string. `undefined` passes, and stays unset. */
function requireNonEmptyIfSet(name: string, value: string | undefined): void {
  if (value !== undefined) {
    requireNonEmpty(name, value);
  }
}

/**
 * Rejects a configuration that cannot produce a working plugin.
 *
 * This throws where the rest of the plugin swallows, and does so at
 * construction: a misconfigured value is a caller mistake, and silently
 * dropping every row is a worse answer than refusing to start.
 *
 * @param config The configuration to check.
 * @throws Error when an option is out of range or names a protected column.
 */
function validateConfig(config: BigQueryLoggerConfig): void {
  requireCount('batchSize', config.batchSize, 1);
  requireCount('queueMaxSize', config.queueMaxSize, 1);
  requireFiniteAboveZero('batchFlushIntervalMs', config.batchFlushIntervalMs);
  requireFiniteAboveZero('shutdownTimeoutMs', config.shutdownTimeoutMs);
  requireContentLimit(config.maxContentLength);
  requireRetryConfig(config.retryConfig ?? {});
  // An empty prefix names a view after the event type alone, so it can collide
  // with an ordinary table in the dataset.
  requireNonEmptyIfSet('viewPrefix', config.viewPrefix);
  requireNonEmptyIfSet('gcsBucketName', config.gcsBucketName);
  requireNonEmptyIfSet('connectionId', config.connectionId);
}

/**
 * Splits the allowlist into the keys that match in full and the prefixes.
 *
 * A trailing `*` marks a prefix pattern and is stripped. Every other entry
 * matches in full, so a plain key such as `citation_metadata` never behaves
 * as a prefix.
 *
 * @param allowlist The caller's entries, if any.
 * @return The two match kinds, ready for the hot path.
 */
export function parseCustomMetadataAllowlist(
  allowlist: readonly string[] | undefined,
): CustomMetadataAllowlist {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of allowlist ?? []) {
    if (entry.endsWith(PREFIX_WILDCARD)) {
      prefixes.push(entry.slice(0, -PREFIX_WILDCARD.length));
    } else {
      exact.add(entry);
    }
  }
  return {exact, prefixes};
}

/** Whether the allowlist can match anything at all. */
export function capturesCustomMetadata(
  allowlist: CustomMetadataAllowlist,
): boolean {
  return allowlist.exact.size > 0 || allowlist.prefixes.length > 0;
}

/**
 * Rejects a configuration that captures metadata into a column it also drops.
 *
 * The capture would be built, sanitized and then thrown away, and a truncated
 * capture would still flip `is_truncated` on a row with no `attributes`.
 */
function requireCaptureIsWritable(
  allowlist: CustomMetadataAllowlist,
  denied: ReadonlySet<AnalyticsPayloadColumn>,
): void {
  if (denied.has('attributes') && capturesCustomMetadata(allowlist)) {
    throw configError(
      `customMetadataAllowlist captures into the attributes column, but ` +
        `payloadColumnDenylist drops it, so the capture would be discarded. ` +
        `Remove attributes from payloadColumnDenylist, or clear ` +
        `customMetadataAllowlist.`,
    );
  }
}

/** Fills every {@link BigQueryLoggerConfig} default in. */
function resolveConfig(
  config: BigQueryLoggerConfig,
  customMetadataAllowlist: CustomMetadataAllowlist,
  deniedColumns: ReadonlySet<AnalyticsPayloadColumn>,
): ResolvedConfig {
  return {
    enabled: config.enabled ?? true,
    eventAllowlist: config.eventAllowlist,
    eventDenylist: config.eventDenylist,
    maxContentLength: config.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH,
    logMultiModalContent: config.logMultiModalContent ?? true,
    contentFormatter: config.contentFormatter,
    logSessionMetadata: config.logSessionMetadata ?? true,
    customTags: config.customTags ?? {},
    finalResponseToolNames: config.finalResponseToolNames ?? [],
    flushOnRunEnd: config.flushOnRunEnd ?? true,
    enableOtelCorrelation: config.enableOtelCorrelation ?? false,
    customMetadataAllowlist,
    deniedColumns,
    gcsBucketName: config.gcsBucketName,
    connectionId: config.connectionId,
  };
}

/** Fills every {@link AnalyticsRetryConfig} default in. */
function resolveRetryConfig(
  retry: AnalyticsRetryConfig,
): ResolvedAnalyticsRetryConfig {
  return {
    maxRetries: retry.maxRetries ?? DEFAULT_MAX_RETRIES,
    initialDelayMs: retry.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    multiplier: retry.multiplier ?? DEFAULT_MULTIPLIER,
    maxDelayMs: retry.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  };
}

/** The table, queue and retry settings the row writer needs. */
function resolveWriterOptions(
  options: BigQueryAgentAnalyticsPluginOptions,
  config: BigQueryLoggerConfig,
  deniedColumns: ReadonlySet<AnalyticsPayloadColumn>,
): BigQueryRowWriterOptions {
  return {
    projectId: options.projectId,
    datasetId: options.datasetId,
    tableId: options.tableId ?? config.tableId ?? DEFAULT_TABLE_ID,
    location: options.location ?? DEFAULT_LOCATION,
    credentials: options.credentials,
    clusteringFields: config.clusteringFields ?? DEFAULT_CLUSTERING_FIELDS,
    batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
    flushIntervalMs:
      config.batchFlushIntervalMs ?? DEFAULT_BATCH_FLUSH_INTERVAL_MS,
    shutdownTimeoutMs: config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    queueMaxSize: config.queueMaxSize ?? DEFAULT_QUEUE_MAX_SIZE,
    retry: resolveRetryConfig(config.retryConfig ?? {}),
    autoSchemaUpgrade: config.autoSchemaUpgrade ?? true,
    createViews: config.createViews ?? true,
    viewPrefix: config.viewPrefix ?? DEFAULT_VIEW_PREFIX,
    deniedColumns,
  };
}

/** The plugin's resolved view of its options and its writer's. */
export interface ResolvedPluginOptions {
  config: ResolvedConfig;
  writer: BigQueryRowWriterOptions;
}

/**
 * Checks the caller's options and fills every default in.
 *
 * Validation happens here and only here, so the plugin and its writer can
 * never disagree about whether a value was checked.
 *
 * @param options The caller's constructor parameters.
 * @return The resolved configuration and the writer's options.
 * @throws Error when an option is out of range or names a protected column.
 */
export function resolvePluginOptions(
  options: BigQueryAgentAnalyticsPluginOptions,
): ResolvedPluginOptions {
  const config = options.config ?? {};
  requireNonEmpty('projectId', options.projectId);
  requireNonEmpty('datasetId', options.datasetId);
  validateConfig(config);
  const customMetadataAllowlist = parseCustomMetadataAllowlist(
    config.customMetadataAllowlist,
  );
  const deniedColumns = validatePayloadColumnDenylist(
    config.payloadColumnDenylist,
  );
  requireCaptureIsWritable(customMetadataAllowlist, deniedColumns);
  return {
    config: resolveConfig(config, customMetadataAllowlist, deniedColumns),
    writer: resolveWriterOptions(options, config, deniedColumns),
  };
}
