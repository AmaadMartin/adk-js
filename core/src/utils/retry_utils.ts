/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatError} from './error_utils.js';
import {logger} from './logger.js';
import {isRecord} from './type_utils.js';

/** The `name` an aborted operation carries, per the DOM `AbortError`. */
const ABORT_ERROR_NAME = 'AbortError';

/**
 * Returns whether an abort is the reason `error` was thrown.
 *
 * A cancellation is often translated into a transport error while the
 * connection tears down, so the original `AbortError` survives only in the
 * `cause` chain. Mirrors Python's `_has_cancelled_error_context`.
 */
function isCancellation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    if (current['name'] === ABORT_ERROR_NAME) {
      return true;
    }
    current = current['cause'];
  }

  return false;
}

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
 * @param abortSignal When already aborted, the failure is a cancellation and
 *     the operation is not retried.
 * @returns The value of whichever attempt succeeded.
 * @throws The error of the second attempt, or of the first when it was
 *     cancelled.
 */
export async function retryOnce<T>(
  operation: () => Promise<T>,
  label: string,
  abortSignal?: AbortSignal,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (abortSignal?.aborted || isCancellation(error)) {
      throw error;
    }

    logger.debug(`Retrying ${label} after error: ${formatError(error)}`);
    return operation();
  }
}
