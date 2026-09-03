/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';

/** The envelope a Bigtable tool returns when it fails. */
export interface BigtableToolError {
  status: 'ERROR';
  error_details: string;
}

/**
 * What every Bigtable tool resolves with.
 *
 * A failure is a value, not a rejection, so the model always receives a
 * readable payload. The keys are `snake_case` because the model reads them,
 * and adk-python's tools spell them that way.
 */
export type BigtableToolResult<T> =
  | ({status: 'SUCCESS'} & T)
  | BigtableToolError;

/**
 * Runs `body` and wraps its outcome in the Bigtable tool envelope.
 *
 * @param toolName The tool being run, used in the failure log.
 * @param body The work the tool performs.
 * @return The body's payload tagged `SUCCESS`, or the `ERROR` envelope.
 */
export async function runBigtableTool<T extends object>(
  toolName: string,
  body: () => Promise<T>,
): Promise<BigtableToolResult<T>> {
  try {
    return {status: 'SUCCESS', ...(await body())};
  } catch (err: unknown) {
    const details = formatError(err);
    logger.warn(`Bigtable tool '${toolName}' failed: ${details}`);
    return {status: 'ERROR', error_details: details};
  }
}
