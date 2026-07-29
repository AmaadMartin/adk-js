/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The error result returned by every BigQuery tool when the underlying API
 * call fails. Tools resolve with this value instead of rejecting so that the
 * failure is surfaced to the LLM as a normal tool response.
 */
export interface BigQueryToolError {
  status: 'ERROR';
  error_details: string;
}

/**
 * Converts a thrown value into the {@link BigQueryToolError} shape shared by
 * all BigQuery tools.
 */
export function toToolError(error: unknown): BigQueryToolError {
  return {
    status: 'ERROR',
    error_details: error instanceof Error ? error.message : String(error),
  };
}
