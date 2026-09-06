/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';

/**
 * What a Spanner tool answers the model with.
 *
 * The keys are `snake_case` because they cross the model boundary and must
 * match what adk-python emits.
 */
export type SpannerToolResult<T extends object = object> =
  | ({status: 'SUCCESS'} & T)
  | {status: 'ERROR'; error_details: string};

/**
 * Runs one tool body and turns any failure into an `ERROR` result.
 *
 * A Spanner tool never throws: the model receives a rejected remote call, a
 * validation failure, a missing peer dependency and a pending authorization
 * in the same envelope, and can read the reason.
 *
 * @param toolName The prefixed tool name, used in the log line.
 * @param call The tool body.
 * @return The body's fields under `SUCCESS`, or the failure under `ERROR`.
 */
export async function runSpannerTool<T extends object>(
  toolName: string,
  call: () => Promise<T>,
): Promise<SpannerToolResult<T>> {
  try {
    return {status: 'SUCCESS', ...(await call())};
  } catch (err: unknown) {
    logger.error(`${toolName} failed: ${formatError(err)}`);
    return {status: 'ERROR', error_details: formatError(err)};
  }
}
