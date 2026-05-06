/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * Write mode indicating what levels of write operations are allowed in BigQuery.
 */
export enum WriteMode {
  /**
   * No write operations are allowed. Only SELECT queries are allowed.
   */
  BLOCKED = 'blocked',

  /**
   * Only protected write operations are allowed in a BigQuery session.
   * Writes to temporary tables in the anonymous dataset of the session are allowed.
   */
  PROTECTED = 'protected',

  /**
   * All write operations are allowed.
   */
  ALLOWED = 'allowed',
}

/**
 * Zod schema for BigQuery tool configuration.
 */
export const BigQueryToolConfigSchema = z
  .object({
    /**
     * Write mode for BigQuery tools.
     */
    writeMode: z.nativeEnum(WriteMode).default(WriteMode.BLOCKED),

    /**
     * Maximum number of bytes to bill for a query. Must be >= 10485760 (10MB).
     */
    maximumBytesBilled: z
      .number()
      .int()
      .min(10485760, {
        message:
          'In BigQuery on-demand pricing, charges are rounded up to the nearest MB, with a minimum 10 MB data processed per table referenced by the query, and with a minimum 10 MB data processed per query. So max_bytes_billed must be set >=10485760.',
      })
      .optional(),

    /**
     * Maximum number of rows to return from a query.
     */
    maxQueryResultRows: z.number().int().default(50),

    /**
     * Name of the application using the BigQuery tools. Should not contain spaces.
     */
    applicationName: z
      .string()
      .refine((val) => !val.includes(' '), {
        message: 'Application name should not contain spaces.',
      })
      .optional(),

    /**
     * GCP project ID to use for the BigQuery compute operations.
     */
    computeProjectId: z.string().optional(),

    /**
     * BigQuery location to use for the data and compute.
     */
    location: z.string().optional(),

    /**
     * Labels to apply to BigQuery jobs for tracking and monitoring.
     * Max 20 labels, keys cannot be empty or start with "adk-bigquery-".
     */
    jobLabels: z
      .record(z.string(), z.string())
      .refine((val) => Object.keys(val).length <= 20, {
        message: 'Only up to 20 job labels can be provided',
      })
      .refine((val) => !Object.keys(val).some((k) => !k), {
        message: 'Label keys cannot be empty.',
      })
      .refine(
        (val) => !Object.keys(val).some((k) => k.startsWith('adk-bigquery-')),
        {
          message:
            'Label key cannot start with "adk-bigquery-" as it is reserved for internal usage',
        },
      )
      .optional(),
  })
  .strict();

/**
 * Configuration for BigQuery tools.
 */
export type BigQueryToolConfig = z.infer<typeof BigQueryToolConfigSchema>;

/**
 * Default configuration for BigQuery tools.
 */
export const DEFAULT_BIGQUERY_TOOL_CONFIG: BigQueryToolConfig =
  BigQueryToolConfigSchema.parse({});
