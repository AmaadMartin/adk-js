/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatError, isAbortError} from './error_utils.js';
import {logger} from './logger.js';

/**
 * Runs `operation`, and runs it a second and final time if the first attempt
 * throws for a reason other than cancellation.
 *
 * Use it only where a failed attempt provably had no remote effect. Retrying an
 * operation that may already have run duplicates its side effect, so a request
 * that reached a server must not go through here. Mirrors Python's
 * `retry_on_errors` decorator.
 *
 * @param operation The operation to run.
 * @param label Names the operation in the retry log line.
 * @return The value of whichever attempt succeeded.
 * @throws The error of the second attempt, or of the first when it was
 *   cancelled.
 */
export async function retryOnce<T>(
  operation: () => Promise<T>,
  label: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw error;
    }

    logger.debug(`Retrying ${label} after error: ${formatError(error)}`);
    return operation();
  }
}
