/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The row cap a query result carries when the caller names none. */
const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/**
 * BigQuery on-demand pricing bills at least 10 MB per query, so a lower cap
 * rejects every query.
 */
const MINIMUM_BYTES_BILLED = 10_485_760;

/** ADK owns the job label keys that start with this prefix. */
const RESERVED_LABEL_PREFIX = 'adk-bigquery-';

/** BigQuery accepts at most this many user labels on one job. */
const MAX_JOB_LABELS = 20;

/**
 * What a BigQuery tool may write (experimental).
 *
 * The three values cross the wire and match adk-python.
 *
 * @experimental Subject to change; not recommended for production use.
 */
export enum WriteMode {
  /** No write runs. Only a read, that is a SELECT query, is allowed. */
  BLOCKED = 'blocked',
  /**
   * Only a write inside a BigQuery session is allowed.
   *
   * The write reaches the anonymous dataset of the session, so the agent can
   * create, change and delete a temporary table there while a permanent table
   * stays protected. See https://cloud.google.com/bigquery/docs/sessions-intro.
   */
  PROTECTED = 'protected',
  /** Every write is allowed. */
  ALLOWED = 'allowed',
}

/**
 * Settings shared by every BigQuery tool (experimental).
 *
 * @experimental Subject to change; not recommended for production use.
 */
export interface BigQueryToolConfig {
  /**
   * What the SQL tool may write. It defaults to {@link WriteMode.BLOCKED},
   * which admits a SELECT statement and nothing else. This default may change
   * in a future version.
   */
  writeMode?: WriteMode;
  /**
   * The most bytes one query may bill.
   *
   * BigQuery on-demand pricing rounds a charge up to the nearest MB and bills
   * at least 10 MB per query, so this must be 10485760 or more.
   */
  maximumBytesBilled?: number;
  /** The most rows a query result carries. It defaults to 50. */
  maxQueryResultRows?: number;
  /**
   * BigQuery location for the data and the compute. When it is unset, BigQuery
   * derives the location from the data the request references. For the
   * supported locations, see
   * https://cloud.google.com/bigquery/docs/locations.
   */
  location?: string;
  /**
   * The one project the SQL tool runs a query in. When it is set, the tool
   * refuses a query that names another project.
   */
  computeProjectId?: string;
  /**
   * Name of the application that uses the BigQuery tools. It is appended to
   * the user agent of every BigQuery API call, and to the job labels under the
   * key `adk-bigquery-application-name`. It must not contain a space.
   *
   * This field serves usage discovery and tracking only. Never base a
   * security-sensitive decision on it.
   */
  applicationName?: string;
  /**
   * Labels that every BigQuery job the tools run carries, for billing,
   * monitoring and organization. See
   * https://cloud.google.com/bigquery/docs/labels-intro.
   *
   * BigQuery accepts at most 20 labels, and ADK reserves a key starting with
   * `adk-bigquery-`.
   *
   * These labels serve usage discovery and tracking only. Never base a
   * security-sensitive decision on them.
   */
  jobLabels?: Record<string, string>;
}

/**
 * A {@link BigQueryToolConfig} with every default applied. A tool reads this,
 * so no tool repeats a default.
 */
export interface ResolvedBigQueryToolConfig extends BigQueryToolConfig {
  writeMode: WriteMode;
  maxQueryResultRows: number;
}

/** Rejects a label set that BigQuery or ADK does not accept. */
function validateJobLabels(jobLabels: Record<string, string>): void {
  const keys = Object.keys(jobLabels);
  if (keys.length > MAX_JOB_LABELS) {
    throw new Error(`Only up to ${MAX_JOB_LABELS} job labels can be provided`);
  }
  for (const key of keys) {
    if (!key) {
      throw new Error('Label keys cannot be empty.');
    }
    if (key.startsWith(RESERVED_LABEL_PREFIX)) {
      throw new Error(
        `Label key cannot start with "${RESERVED_LABEL_PREFIX}" as it is` +
          ` reserved for internal usage, found "${key}".`,
      );
    }
  }
}

/**
 * Applies the defaults to a tool configuration and rejects a value the tools
 * cannot honour.
 *
 * Each message matches adk-python word for word, so a user who moves between
 * the two SDKs reads the same text.
 *
 * @param config The configuration the caller supplied, if any.
 * @return The configuration with `writeMode` and `maxQueryResultRows` set.
 * @throws Error When a value is out of range, or a job label is reserved.
 */
export function resolveBigQueryToolConfig(
  config: BigQueryToolConfig = {},
): ResolvedBigQueryToolConfig {
  if (
    config.maximumBytesBilled &&
    config.maximumBytesBilled < MINIMUM_BYTES_BILLED
  ) {
    throw new Error(
      'In BigQuery on-demand pricing, charges are rounded up to the nearest' +
        ' MB, with a minimum 10 MB data processed per table referenced by the' +
        ' query, and with a minimum 10 MB data processed per query. So' +
        ' max_bytes_billed must be set >=10485760.',
    );
  }
  if (config.applicationName?.includes(' ')) {
    throw new Error('Application name should not contain spaces.');
  }
  if (config.jobLabels) {
    validateJobLabels(config.jobLabels);
  }
  return {
    ...config,
    writeMode: config.writeMode ?? WriteMode.BLOCKED,
    maxQueryResultRows:
      config.maxQueryResultRows ?? DEFAULT_MAX_QUERY_RESULT_ROWS,
  };
}
