/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The value shape every BigQuery tool resolves to.
 *
 * adk-python catches broadly in each tool and returns `{"status": "ERROR",
 * "error_details": ...}` rather than raising, so the model reads the failure
 * instead of the turn aborting. These helpers reproduce that. The result keys
 * stay `snake_case` because the model reads them.
 */

import {formatError} from '../../utils/error_utils.js';

/** A BigQuery tool reporting that its call failed. */
export interface BigQueryToolError {
  status: 'ERROR';
  error_details: string;
}

/** A BigQuery tool result: the tool's own payload, or a failure. */
export type BigQueryToolResult<T> = T | BigQueryToolError;

/**
 * Builds the failure envelope.
 *
 * @param details Why the call failed, as the model should read it.
 * @return The failure envelope.
 */
export function bigQueryToolError(details: string): BigQueryToolError {
  return {status: 'ERROR', error_details: details};
}

/**
 * Whether a tool result is the failure envelope.
 *
 * @param result A result returned by one of the BigQuery tools.
 * @return True when the call failed.
 */
export function isBigQueryToolError(
  result: unknown,
): result is BigQueryToolError {
  return (
    typeof result === 'object' &&
    result !== null &&
    'status' in result &&
    (result as {status: unknown}).status === 'ERROR'
  );
}

/**
 * Runs a BigQuery tool body, turning a thrown failure into the envelope.
 *
 * @param run The tool body.
 * @return The body's value, or the failure envelope.
 */
export async function runBigQueryTool<T>(
  run: () => Promise<T>,
): Promise<BigQueryToolResult<T>> {
  try {
    return await run();
  } catch (err: unknown) {
    return bigQueryToolError(formatError(err));
  }
}
