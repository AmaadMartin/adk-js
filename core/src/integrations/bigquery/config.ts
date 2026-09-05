/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../../errors/input_validation_error.js';

/** Smallest `maximumBytesBilled` BigQuery on-demand pricing accepts. */
const MINIMUM_BYTES_BILLED = 10_485_760;

/** How many job labels a caller may provide. */
const MAX_JOB_LABELS = 20;

/** Job label key prefix reserved for labels the tools set themselves. */
const RESERVED_JOB_LABEL_PREFIX = 'adk-bigquery-';

/** Row cap a query result carries when the caller names none. */
const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/**
 * Write mode indicating what levels of write operations are allowed in
 * BigQuery.
 */
export enum WriteMode {
  /**
   * No write operations are allowed.
   *
   * This mode implies that only read (i.e. SELECT query) operations are
   * allowed.
   */
  BLOCKED = 'blocked',

  /**
   * Only protected write operations are allowed in a BigQuery session.
   *
   * In this mode write operations in the anonymous dataset of a BigQuery
   * session are allowed. For example, a temporary table can be created,
   * manipulated and deleted in the anonymous dataset during Agent interaction,
   * while protecting permanent tables from being modified or deleted. To learn
   * more about BigQuery sessions, see
   * https://cloud.google.com/bigquery/docs/sessions-intro.
   */
  PROTECTED = 'protected',

  /** All write operations are allowed. */
  ALLOWED = 'allowed',
}

/** Configuration for BigQuery tools. */
export interface BigQueryToolConfig {
  /**
   * Write mode for BigQuery tools.
   *
   * By default, the tool will allow only read operations. This behaviour may
   * change in future versions.
   */
  writeMode: WriteMode;

  /**
   * Maximum number of bytes to bill for a query.
   *
   * In BigQuery on-demand pricing, charges are rounded up to the nearest MB,
   * with a minimum 10 MB data processed per table referenced by the query, and
   * with a minimum 10 MB data processed per query. So this value must be set
   * >=10485760.
   */
  maximumBytesBilled?: number;

  /**
   * Maximum number of rows to return from a query.
   *
   * By default, the query result will be limited to 50 rows.
   */
  maxQueryResultRows: number;

  /**
   * Name of the application using the BigQuery tools.
   *
   * By default, no particular application name will be set in the BigQuery
   * interaction. But if the tool user (agent builder) wants to differentiate
   * their application/agent for tracking or support purpose, they can set this
   * field. If set, this value will be added to the user_agent in BigQuery API
   * calls, and also to the BigQuery job labels with the key
   * "adk-bigquery-application-name".
   *
   * Note: This field is for usage discovery and tracking purposes only and
   * should not be used for security-sensitive decisions.
   */
  applicationName?: string;

  /**
   * GCP project ID to use for the BigQuery compute operations.
   *
   * This can be set as a guardrail to ensure that the tools perform the
   * compute operations (such as query execution) in a specific project.
   */
  computeProjectId?: string;

  /**
   * BigQuery location to use for the data and compute.
   *
   * This can be set if the BigQuery tools are expected to process data in a
   * particular BigQuery location. If not set, then location would be
   * automatically determined based on the data location in the query. For all
   * supported locations, see
   * https://cloud.google.com/bigquery/docs/locations.
   */
  location?: string;

  /**
   * Labels to apply to BigQuery jobs for tracking and monitoring.
   *
   * These labels will be added to all BigQuery jobs executed by the tools.
   * Labels must be key-value pairs where both keys and values are strings.
   * Labels can be used for billing, monitoring, and resource organization. For
   * more information about labels, see
   * https://cloud.google.com/bigquery/docs/labels-intro.
   *
   * Note: These labels are for usage discovery and tracking purposes only and
   * should not be used for security-sensitive decisions. The number of
   * user-provided labels is restricted to 20, and keys starting with
   * "adk-bigquery-" are reserved for internal usage.
   */
  jobLabels?: Record<string, string>;
}

// Unknown keys are rejected, which is what adk-python's `extra='forbid'`
// does. The schema stays module-private: the type and the factory are the
// public surface.
const bigQueryToolConfigSchema = z.strictObject({
  writeMode: z.enum(WriteMode).optional(),
  maximumBytesBilled: z.int().optional(),
  maxQueryResultRows: z.int().optional(),
  applicationName: z.string().optional(),
  computeProjectId: z.string().optional(),
  location: z.string().optional(),
  jobLabels: z.record(z.string(), z.string()).optional(),
});

function validateMaximumBytesBilled(value: number | undefined): void {
  // adk-python guards with `if v and v < ...`, so 0 passes and every other
  // value below the minimum, negatives included, is rejected.
  if (value && value < MINIMUM_BYTES_BILLED) {
    throw new InputValidationError(
      'In BigQuery on-demand pricing, charges are rounded up to the nearest' +
        ' MB, with a minimum 10 MB data processed per table referenced by the' +
        ' query, and with a minimum 10 MB data processed per query. So' +
        ` maximumBytesBilled must be set >=${MINIMUM_BYTES_BILLED}.`,
    );
  }
}

function validateApplicationName(value: string | undefined): void {
  if (value && value.includes(' ')) {
    throw new InputValidationError(
      'Application name should not contain spaces.',
    );
  }
}

function validateJobLabels(labels: Record<string, string> | undefined): void {
  if (labels === undefined) {
    return;
  }
  const keys = Object.keys(labels);
  if (keys.length > MAX_JOB_LABELS) {
    throw new InputValidationError(
      `Only up to ${MAX_JOB_LABELS} job labels can be provided`,
    );
  }
  for (const key of keys) {
    if (!key) {
      throw new InputValidationError('Label keys cannot be empty.');
    }
    if (key.startsWith(RESERVED_JOB_LABEL_PREFIX)) {
      throw new InputValidationError(
        `Label key cannot start with "${RESERVED_JOB_LABEL_PREFIX}" as it is` +
          ` reserved for internal usage, found "${key}".`,
      );
    }
  }
}

/**
 * Creates a validated {@link BigQueryToolConfig}.
 *
 * @param params Optional {@link BigQueryToolConfig} fields. Unset fields take
 *     their defaults: {@link WriteMode.BLOCKED} and 50 result rows.
 * @returns A validated {@link BigQueryToolConfig}, freshly built and sharing
 *     no reference with `params`.
 * @throws {InputValidationError} When `params` carries an unknown key or a
 *     field of the wrong type, when `maximumBytesBilled` is below the BigQuery
 *     on-demand minimum, when `applicationName` contains a space, or when
 *     `jobLabels` exceeds 20 entries or holds an empty or reserved key.
 */
export function createBigQueryToolConfig(
  params: Partial<BigQueryToolConfig> = {},
): BigQueryToolConfig {
  const result = bigQueryToolConfigSchema.safeParse(params);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid BigQueryToolConfig: ${z.prettifyError(result.error)}`,
    );
  }
  const config = result.data;
  validateMaximumBytesBilled(config.maximumBytesBilled);
  validateApplicationName(config.applicationName);
  validateJobLabels(config.jobLabels);
  return {
    ...config,
    writeMode: config.writeMode ?? WriteMode.BLOCKED,
    maxQueryResultRows:
      config.maxQueryResultRows ?? DEFAULT_MAX_QUERY_RESULT_ROWS,
  };
}
