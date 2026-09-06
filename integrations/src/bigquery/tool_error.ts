/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The payload a BigQuery tool returns to the model when a call fails
 * (experimental).
 *
 * The field names are model-facing wire values, so they keep the snake_case
 * spelling adk-python uses.
 *
 * @experimental Subject to change; not recommended for production use.
 */
export interface BigQueryToolError {
  status: 'ERROR';
  error_details: string;
}

/**
 * Wraps a failure in the payload the model reads.
 *
 * @param error The rejection the BigQuery client produced.
 * @return The error payload, carrying the message unchanged.
 */
export function toBigQueryToolError(error: unknown): BigQueryToolError {
  return {
    status: 'ERROR',
    error_details: error instanceof Error ? error.message : String(error),
  };
}
