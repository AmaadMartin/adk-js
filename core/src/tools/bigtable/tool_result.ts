/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger} from '../../utils/logger.js';

const logger = getLogger();

/**
 * What every Bigtable tool returns to the model: either the payload it asked
 * for or a description of why the call failed.
 */
export type BigtableToolResult<T> =
  | {status: 'SUCCESS'; results: T}
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
export async function runBigtableTool<T>(
  toolName: string,
  call: () => Promise<T>,
): Promise<BigtableToolResult<T>> {
  try {
    return {status: 'SUCCESS', results: await call()};
  } catch (ex) {
    logger.error(`Bigtable tool ${toolName} failed: ${ex}`);
    return {status: 'ERROR', error_details: String(ex)};
  }
}
