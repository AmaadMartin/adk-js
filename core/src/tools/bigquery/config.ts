/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Configuration of the BigQuery tools.
 *
 * Ported from adk-python `src/google/adk/integrations/bigquery/config.py`
 * (branch `main`). Field names are camelCase here; the semantics, the defaults
 * and the validation messages match the Python model.
 */

/** What kind of write operations the BigQuery tools may perform. */
export enum WriteMode {
  /**
   * No write operation is allowed. Only a read (`SELECT`) query runs.
   */
  BLOCKED = 'blocked',
  /**
   * Only a protected write operation is allowed, inside a BigQuery session.
   *
   * A temporary table can be created, changed and dropped in the anonymous
   * dataset of the session while a permanent table stays protected. See
   * https://cloud.google.com/bigquery/docs/sessions-intro.
   */
  PROTECTED = 'protected',
  /** Every write operation is allowed. */
  ALLOWED = 'allowed',
}

/** Default of {@link BigQueryToolConfig.maxQueryResultRows}. */
export const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/**
 * Lowest accepted {@link BigQueryToolConfig.maximumBytesBilled}.
 *
 * BigQuery on-demand pricing rounds a charge up to the nearest MB, with a
 * minimum of 10 MB per query, so a lower cap can never take effect.
 */
export const MINIMUM_BYTES_BILLED = 10_485_760;

/** How many job labels a caller may supply. */
export const MAX_JOB_LABELS = 20;

/** Job label key prefix the tools reserve for themselves. */
export const RESERVED_JOB_LABEL_PREFIX = 'adk-bigquery-';

/** Configuration of the BigQuery tools. */
export interface BigQueryToolConfig {
  /**
   * Which write operations the tools may perform. Defaults to
   * {@link WriteMode.BLOCKED}, so only read queries run.
   */
  writeMode?: WriteMode;
  /**
   * Cap on the bytes a query may bill. Must be at least `10485760`, because
   * BigQuery on-demand pricing bills a minimum of 10 MB per query. Absent
   * means no cap.
   */
  maximumBytesBilled?: number;
  /** How many rows a query result may carry. Defaults to `50`. */
  maxQueryResultRows?: number;
  /**
   * Name of the application that uses the tools. It is added to the BigQuery
   * user agent and to the job label `adk-bigquery-application-name`. It must
   * not contain a space.
   *
   * This name serves usage discovery and tracking. Do not use it for a
   * security-sensitive decision.
   */
  applicationName?: string;
  /**
   * Project the tools must run their compute in. When set, a query for another
   * project is refused.
   */
  computeProjectId?: string;
  /**
   * BigQuery location of the data and the compute. Absent means BigQuery
   * picks the location from the data the query reads. See
   * https://cloud.google.com/bigquery/docs/locations.
   */
  location?: string;
  /**
   * Labels applied to every BigQuery job the tools run. At most 20 entries;
   * a key must not be empty and must not start with `adk-bigquery-`, which
   * the tools reserve. See
   * https://cloud.google.com/bigquery/docs/labels-intro.
   *
   * These labels serve usage discovery and tracking. Do not use them for a
   * security-sensitive decision.
   */
  jobLabels?: Record<string, string>;
}

/**
 * A {@link BigQueryToolConfig} with every default applied, as the tools read
 * it. Produced by {@link createBigQueryToolConfig}.
 */
export interface ResolvedBigQueryToolConfig extends BigQueryToolConfig {
  writeMode: WriteMode;
  maxQueryResultRows: number;
}

/** Rejects a `maximumBytesBilled` a BigQuery job could never honour. */
function validateMaximumBytesBilled(value: number | undefined): void {
  if (value && value < MINIMUM_BYTES_BILLED) {
    throw new Error(
      'In BigQuery on-demand pricing, charges are rounded up to the nearest' +
        ' MB, with a minimum 10 MB data processed per table referenced by the' +
        ' query, and with a minimum 10 MB data processed per query. So' +
        ' max_bytes_billed must be set >=10485760.',
    );
  }
}

/** Rejects an application name BigQuery cannot carry in a user agent. */
function validateApplicationName(value: string | undefined): void {
  if (value && value.includes(' ')) {
    throw new Error('Application name should not contain spaces.');
  }
}

/** Rejects job labels BigQuery or the tools cannot accept. */
function validateJobLabels(labels: Record<string, string> | undefined): void {
  if (labels === undefined) {
    return;
  }
  const keys = Object.keys(labels);
  if (keys.length > MAX_JOB_LABELS) {
    throw new Error(`Only up to ${MAX_JOB_LABELS} job labels can be provided`);
  }
  for (const key of keys) {
    if (!key) {
      throw new Error('Label keys cannot be empty.');
    }
    if (key.startsWith(RESERVED_JOB_LABEL_PREFIX)) {
      throw new Error(
        `Label key cannot start with "${RESERVED_JOB_LABEL_PREFIX}" as it is` +
          ` reserved for internal usage, found "${key}".`,
      );
    }
  }
}

/**
 * Validates a BigQuery tool configuration and applies its defaults.
 *
 * The returned object is a fresh copy, so a later change to the argument
 * cannot reach the tools that already read it.
 *
 * @param config The caller's configuration. Absent means every default.
 * @return The configuration the tools read.
 * @throws If a value is out of range.
 */
export function createBigQueryToolConfig(
  config: BigQueryToolConfig = {},
): ResolvedBigQueryToolConfig {
  validateMaximumBytesBilled(config.maximumBytesBilled);
  validateApplicationName(config.applicationName);
  validateJobLabels(config.jobLabels);

  return {
    ...config,
    writeMode: config.writeMode ?? WriteMode.BLOCKED,
    maxQueryResultRows:
      config.maxQueryResultRows ?? DEFAULT_MAX_QUERY_RESULT_ROWS,
    jobLabels: config.jobLabels && {...config.jobLabels},
  };
}
