/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How a BigQuery tool call ended (experimental).
 *
 * The two values reach the model, so they match adk-python.
 *
 * @experimental Subject to change; not recommended for production use.
 */
export enum BigQueryToolStatus {
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR',
}

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
  status: BigQueryToolStatus.ERROR;
  error_details: string;
}

/**
 * Wraps a failure in the payload the model reads.
 *
 * @param error The rejection the BigQuery client produced.
 * @return The error payload, carrying the message unchanged.
 */
export function toBigQueryToolError(error: unknown): BigQueryToolError {
  return bigQueryToolError(
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * The payload a tool returns when it refuses a call itself, rather than
 * relaying a BigQuery failure.
 *
 * @param message What the model must know to correct the call.
 * @return The error payload.
 */
export function bigQueryToolError(message: string): BigQueryToolError {
  return {status: BigQueryToolStatus.ERROR, error_details: message};
}
