/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Helper for waiting on a long-running operation (LRO) that a service returns
 * from a create call, so that each caller does not hand-roll its own poll loop.
 */

/** Milliseconds between successive polls of a long-running operation. */
const POLL_INTERVAL_MS = 1000;

/** The subset of a long-running operation this helper observes. */
interface PollableOperation {
  name?: string;
  done?: boolean;
}

/** Parameters for {@link waitForOperation}. */
export interface WaitForOperationParams<T extends PollableOperation> {
  /** The operation returned by the create call. */
  operation: T;
  /** Fetches the latest state of the operation. */
  poll: () => Promise<T>;
  /** How long to keep polling before giving up. */
  timeoutSeconds: number;
  /** What is being created, e.g. `'Agent Engine creation'`. */
  description: string;
}

/**
 * Polls `operation` until it reports `done`, and returns the operation in that
 * state. Throws when the deadline passes first.
 *
 * A `timeoutSeconds` below one poll interval (including `0`, a negative value
 * or `NaN`) allows no poll, so an operation that is not already done fails
 * immediately.
 */
export async function waitForOperation<T extends PollableOperation>(
  params: WaitForOperationParams<T>,
): Promise<T> {
  const maxAttempts = Math.ceil(
    params.timeoutSeconds / (POLL_INTERVAL_MS / 1000),
  );
  let current = params.operation;
  let attempts = 0;
  while (!current.done && attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    current = await params.poll();
    attempts++;
  }

  if (!current.done) {
    throw new Error(
      `${params.description} operation ${params.operation.name} did not complete in time.`,
    );
  }

  return current;
}
