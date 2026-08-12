/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';

/**
 * What every Bigtable tool returns to the model: the payload it asked for
 * alongside a `SUCCESS` status, or a description of why the call failed.
 *
 * The payload is spread into the envelope rather than nested, and its field
 * names stay snake_case, so that a result is byte-compatible with the one
 * adk-python returns for the same call.
 */
export type BigtableToolResult<T extends object> =
  | ({status: 'SUCCESS'} & T)
  | {status: 'ERROR'; error_details: string};

/**
 * Runs a Bigtable API call and wraps the outcome in a {@link BigtableToolResult}.
 *
 * Tools report failures to the model instead of throwing, so a bad instance id
 * or a permission error becomes something the model can react to.
 *
 * @param toolName Name of the calling tool, included in the error log so a
 *     failure can be attributed to a specific call.
 * @param call The Bigtable API call to run.
 */
export async function runBigtableTool<T extends object>(
  toolName: string,
  call: () => Promise<T>,
): Promise<BigtableToolResult<T>> {
  try {
    return {status: 'SUCCESS', ...(await call())};
  } catch (ex: unknown) {
    const errorDetails = formatError(ex);
    logger.error(`Bigtable tool ${toolName} failed: ${errorDetails}`);
    return {status: 'ERROR', error_details: errorDetails};
  }
}
