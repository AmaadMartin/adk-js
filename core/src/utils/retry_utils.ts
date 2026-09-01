/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatError, isAbortError} from './error_utils.js';
import {logger} from './logger.js';

/** Options for {@link retryOnce}. */
export interface RetryOnceOptions {
  /** Names the operation in the retry log line. */
  label: string;
  /** When already aborted, the failure is a cancellation and is not retried. */
  abortSignal?: AbortSignal;
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
 * @param options Log label, and the signal that marks a cancellation.
 * @returns The value of whichever attempt succeeded.
 * @throws The error of the second attempt, or of the first when it was
 *     cancelled.
 */
export async function retryOnce<T>(
  operation: () => Promise<T>,
  options: RetryOnceOptions,
): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    // `isAbortError` searches the whole error graph. A cancellation is often
    // translated into a transport error while the connection tears down, so
    // the original `AbortError` survives only in the `cause` chain or in an
    // `AggregateError`. Mirrors Python's `_has_cancelled_error_context`.
    if (options.abortSignal?.aborted || isAbortError(error)) {
      throw error;
    }

    logger.debug(
      `Retrying ${options.label} after error: ${formatError(error)}`,
    );
    return operation();
  }
}
