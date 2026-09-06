/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NO_LENGTH_LIMIT} from '../utils/sanitize_utils.js';
import {AnalyticsEventType} from './bigquery_analytics_schema.js';
import type {BigQueryRowWriterOptions} from './bigquery_analytics_writer.js';

/** Default configuration values, matching adk-python's `BigQueryLoggerConfig`. */
const DEFAULT_TABLE_ID = 'agent_events';
const DEFAULT_LOCATION = 'US';
const DEFAULT_MAX_CONTENT_LENGTH = 500 * 1024;
const DEFAULT_CLUSTERING_FIELDS = ['event_type', 'agent', 'user_id'];
const DEFAULT_BATCH_SIZE = 1;
const DEFAULT_BATCH_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_QUEUE_MAX_SIZE = 10000;

/** Turns a payload into the value written to the `content` column. */
export type AnalyticsContentFormatter = (
  content: unknown,
  eventType: string,
) => unknown;

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
}

/**
 * The options counting whole rows or whole milliseconds. Below 1 a plugin
 * builds but writes nothing useful: a queue of zero drops every row, a batch
 * of zero never fills, and a shutdown of zero drains nothing.
 */
const POSITIVE_INTEGER_KEYS = [
  'batchSize',
  'batchFlushIntervalMs',
  'shutdownTimeoutMs',
  'queueMaxSize',
] as const satisfies ReadonlyArray<keyof BigQueryLoggerConfig>;

/**
 * Rejects a configuration that cannot produce a working plugin.
 *
 * This throws where the rest of the plugin swallows, and does so at
 * construction: a misconfigured value is a caller mistake, and silently
 * dropping every row is a worse answer than refusing to start.
 *
 * @param config The configuration to check.
 * @throws Error when a numeric option is not an integer in range.
 */
function validateConfig(config: BigQueryLoggerConfig): void {
  for (const name of POSITIVE_INTEGER_KEYS) {
    const value = config[name];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(
        `BigQueryAgentAnalyticsPlugin: ${name} must be an integer of at ` +
          `least 1, got ${String(value)}.`,
      );
    }
  }
  const limit = config.maxContentLength;
  if (
    limit !== undefined &&
    limit !== NO_LENGTH_LIMIT &&
    (!Number.isInteger(limit) || limit < 1)
  ) {
    throw new Error(
      `BigQueryAgentAnalyticsPlugin: maxContentLength must be an integer of ` +
        `at least 1, or ${NO_LENGTH_LIMIT} for no limit, got ` +
        `${String(limit)}.`,
    );
  }
}

/**
 * Fills every {@link BigQueryLoggerConfig} default in, rejecting a
 * configuration that cannot produce a working plugin.
 *
 * @param config The caller's configuration.
 * @return The same configuration with every default filled in.
 * @throws Error when a numeric option is not an integer in range.
 */
export function resolveConfig(config: BigQueryLoggerConfig): ResolvedConfig {
  validateConfig(config);
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
  };
}

/**
 * The table and queue settings the row writer needs, with every default
 * filled in.
 *
 * @param options The caller's constructor parameters.
 * @return The writer's options.
 */
export function resolveWriterOptions(
  options: BigQueryAgentAnalyticsPluginOptions,
): BigQueryRowWriterOptions {
  const config = options.config ?? {};
  return {
    projectId: options.projectId,
    datasetId: options.datasetId,
    tableId: options.tableId ?? DEFAULT_TABLE_ID,
    location: options.location ?? DEFAULT_LOCATION,
    clusteringFields: config.clusteringFields ?? DEFAULT_CLUSTERING_FIELDS,
    batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
    flushIntervalMs:
      config.batchFlushIntervalMs ?? DEFAULT_BATCH_FLUSH_INTERVAL_MS,
    shutdownTimeoutMs: config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    queueMaxSize: config.queueMaxSize ?? DEFAULT_QUEUE_MAX_SIZE,
  };
}
