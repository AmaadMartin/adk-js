/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {formatError, isAbortError} from './error_utils.js';
import {logger} from './logger.js';

/** Options for {@link retryOnce}. */
export interface RetryOnceOptions {
  /** Aborting this signal suppresses the retry. */
  signal?: AbortSignal;
  /** Short noun phrase naming the operation, used only in the retry log. */
  description: string;
}

/**
 * Runs `fn`, and runs it one more time when the first attempt rejects.
 *
 * A second immediate attempt absorbs a transient failure, so there is no
 * backoff, no delay and no attempt count to configure. Cancellation is
 * terminal: when `options.signal` is already aborted, or the rejection carries
 * a cancellation anywhere in its cause chain, the rejection propagates and no
 * second attempt runs.
 *
 * The caller decides whether `fn` is safe to run twice. `retryOnce` cannot
 * check that.
 *
 * @param fn The operation to run. Called at most twice.
 * @param options The cancellation signal and the log description.
 * @return The value of whichever attempt resolves. When both attempts reject,
 *     the rejection is the second error, not the first.
 */
export async function retryOnce<T>(
  fn: () => Promise<T>,
  options: RetryOnceOptions,
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    // The signal is checked first: an abort can surface as an unrelated error
    // type during teardown, which the error graph alone does not reveal.
    if (options.signal?.aborted || isAbortError(err)) {
      throw err;
    }
    logger.debug(
      `Retrying ${options.description} after error: ${formatError(err)}`,
    );
    return fn();
  }
}
