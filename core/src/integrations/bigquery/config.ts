/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/** What kind of write a BigQuery tool may perform. */
export enum WriteMode {
  /**
   * No write operation is allowed, so only a SELECT query runs.
   */
  BLOCKED = 'blocked',
  /**
   * Only a write into the anonymous dataset of a BigQuery session is allowed.
   *
   * An agent can create, change and drop a temporary table for the length of
   * the interaction while a permanent table stays protected. See
   * https://cloud.google.com/bigquery/docs/sessions-intro.
   */
  PROTECTED = 'protected',
  /** Every write operation is allowed. */
  ALLOWED = 'allowed',
}

/**
 * The smallest `maximumBytesBilled` BigQuery on-demand pricing accepts.
 *
 * Charges round up to the nearest MB, with a 10 MB floor per query and per
 * table the query reads.
 */
export const MINIMUM_BYTES_BILLED = 10_485_760;

/** How many rows a query returns when the caller sets no cap. */
export const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/** How many job labels a caller may supply. */
export const MAX_JOB_LABELS = 20;

/** The job-label key prefix the tools reserve for themselves. */
export const RESERVED_JOB_LABEL_PREFIX = 'adk-bigquery-';

/** The job label carrying {@link BigQueryToolConfig.applicationName}. */
export const APPLICATION_NAME_JOB_LABEL = `${RESERVED_JOB_LABEL_PREFIX}application-name`;

/** The job label carrying the name of the tool that started the job. */
export const TOOL_NAME_JOB_LABEL = `${RESERVED_JOB_LABEL_PREFIX}tool`;

/**
 * Rejects a byte budget BigQuery would refuse anyway.
 *
 * `0` passes: adk-python guards with `if v and v < 10_485_760`, so a falsy
 * value skips the check, and that behaviour crosses the language boundary.
 */
function isAllowedBytesBilled(value: number | undefined): boolean {
  return !value || value >= MINIMUM_BYTES_BILLED;
}

const BYTES_BILLED_MESSAGE =
  'In BigQuery on-demand pricing, charges are rounded up to the nearest MB,' +
  ' with a minimum 10 MB data processed per table referenced by the query,' +
  ' and with a minimum 10 MB data processed per query. So max_bytes_billed' +
  ` must be set >=${MINIMUM_BYTES_BILLED}.`;

/** Reports the first job-label rule a map breaks, or `undefined`. */
function jobLabelsError(labels: Record<string, string>): string | undefined {
  const keys = Object.keys(labels);
  if (keys.length > MAX_JOB_LABELS) {
    return `Only up to ${MAX_JOB_LABELS} job labels can be provided`;
  }
  for (const key of keys) {
    if (!key) {
      return 'Label keys cannot be empty.';
    }
    if (key.startsWith(RESERVED_JOB_LABEL_PREFIX)) {
      return (
        `Label key cannot start with "${RESERVED_JOB_LABEL_PREFIX}" as it is` +
        ` reserved for internal usage, found "${key}".`
      );
    }
  }
  return undefined;
}

/**
 * The BigQuery tool settings, with every default applied.
 *
 * adk-python declares the same fields on a pydantic model that forbids extra
 * keys; {@link bigQueryToolConfigSchema} is that model, and this is what it
 * produces.
 */
export const bigQueryToolConfigSchema = z.strictObject({
  /** What kind of write `execute_sql` may run. */
  writeMode: z.enum(WriteMode).default(WriteMode.BLOCKED),
  /**
   * The byte budget for a query, or unset to leave it to BigQuery.
   */
  maximumBytesBilled: z
    .number()
    .optional()
    .refine(isAllowedBytesBilled, BYTES_BILLED_MESSAGE),
  /** How many rows a query result may carry. */
  maxQueryResultRows: z.number().default(DEFAULT_MAX_QUERY_RESULT_ROWS),
  /**
   * The name of the application using the tools.
   *
   * It is added to the BigQuery user agent and to a job label, so an operator
   * can tell one agent's traffic from another's. Use it for tracking only,
   * never for a security decision.
   */
  applicationName: z
    .string()
    .optional()
    .refine(
      (value) => !value?.includes(' '),
      'Application name should not contain spaces.',
    ),
  /**
   * The only project the tools may run compute in.
   *
   * Set it as a guardrail: `execute_sql` refuses a query aimed anywhere else.
   */
  computeProjectId: z.string().optional(),
  /**
   * The BigQuery location holding the data and running the compute. Unset
   * lets BigQuery derive it from the query. See
   * https://cloud.google.com/bigquery/docs/locations.
   */
  location: z.string().optional(),
  /**
   * Labels added to every BigQuery job the tools start, for billing and
   * monitoring. See https://cloud.google.com/bigquery/docs/labels-intro.
   *
   * At most {@link MAX_JOB_LABELS} labels, no empty key, and no key starting
   * with {@link RESERVED_JOB_LABEL_PREFIX}. Use them for tracking only, never
   * for a security decision.
   */
  jobLabels: z
    .record(z.string(), z.string())
    .optional()
    .superRefine((labels, ctx) => {
      const error = labels && jobLabelsError(labels);
      if (error) {
        ctx.addIssue({code: 'custom', message: error});
      }
    }),
});

/**
 * How a caller configures the BigQuery tools. Every field is optional.
 *
 * Unknown keys are rejected, matching adk-python's `extra='forbid'`.
 */
export type BigQueryToolConfig = z.input<typeof bigQueryToolConfigSchema>;

/** The settings a BigQuery tool runs with, once defaults are applied. */
export type BigQueryToolSettings = z.output<typeof bigQueryToolConfigSchema>;

/**
 * Validates a configuration and fills in its defaults.
 *
 * @param config The caller's configuration, or nothing for every default.
 * @return The settings the tools run with.
 * @throws {z.ZodError} If a field breaks a rule, or the object carries a key
 *     the configuration does not declare.
 */
export function createBigQueryToolSettings(
  config: BigQueryToolConfig = {},
): BigQueryToolSettings {
  return bigQueryToolConfigSchema.parse(config);
}
