/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';

/**
 * What a Cloud Storage tool answers the model with.
 *
 * The keys are `snake_case` because they cross the model boundary and must
 * match what adk-python emits.
 */
export type GcsToolResult<T extends object = object> =
  | ({status: 'SUCCESS'} & T)
  | {status: 'ERROR'; error_details: string};

/**
 * Runs one tool body and turns any failure into an `ERROR` result.
 *
 * A Cloud Storage tool never throws: the model receives a rejected API call, a
 * validation failure and a missing peer dependency in the same envelope, and
 * can read the reason.
 *
 * A body that returns a string has produced the final answer itself and it is
 * passed through unchanged. That is how a pending authorization reaches the
 * model as the plain sentence adk-python's `GoogleTool.run_async` returns,
 * rather than as a result envelope.
 *
 * @param toolName The prefixed tool name, used in the log line.
 * @param call The tool body.
 * @return The body's fields under `SUCCESS`, its own string answer, or the
 *   failure under `ERROR`.
 */
export async function runGcsTool<T extends object>(
  toolName: string,
  call: () => Promise<T | string>,
): Promise<GcsToolResult<T> | string> {
  try {
    const result = await call();
    return typeof result === 'string' ? result : {status: 'SUCCESS', ...result};
  } catch (err: unknown) {
    logger.error(`${toolName} failed: ${formatError(err)}`);
    return {status: 'ERROR', error_details: formatError(err)};
  }
}
