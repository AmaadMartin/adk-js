/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Errors raised by the workflow framework.
 *
 * Ported from `google/adk-python` `workflow/_errors.py`.
 */

/**
 * Internal: raised when a dynamic node interrupts (HITL).
 *
 * Used exclusively by `ctx.runNode()` to signal that the dynamic child has
 * unresolved interrupt IDs. The parent's NodeRunner catches this and reads the
 * interrupt IDs from the parent's ctx (set by `ctx.runNode()` before throwing).
 *
 * Internal to the framework — not part of the public API.
 */
export class NodeInterruptedError extends Error {
  constructor(message = 'Node interrupted (awaiting resume input).') {
    super(message);
    this.name = 'NodeInterruptedError';
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, NodeInterruptedError.prototype);
  }
}

/**
 * Type guard for {@link NodeInterruptedError}.
 *
 * Matches on `name` rather than `instanceof <subclass>` so it stays correct when
 * errors cross a package boundary (two copies of adk-js in one runtime would
 * fail an `instanceof` check between them).
 */
export function isNodeInterruptedError(e: unknown): e is NodeInterruptedError {
  return e instanceof Error && e.name === 'NodeInterruptedError';
}

/**
 * Raised when a node exceeds its configured timeout.
 *
 * This is a regular `Error` (retryable) so a timed-out node can be retried via
 * `retryConfig`.
 */
export class NodeTimeoutError extends Error {
  readonly nodeName: string;
  readonly timeout: number;

  /**
   * @param options.nodeName The name of the node that timed out.
   * @param options.timeout The timeout, in seconds, that was exceeded.
   */
  constructor(options: {nodeName: string; timeout: number}) {
    super(
      `Node '${options.nodeName}' timed out after ${options.timeout} seconds.`,
    );
    this.name = 'NodeTimeoutError';
    this.nodeName = options.nodeName;
    this.timeout = options.timeout;
    Object.setPrototypeOf(this, NodeTimeoutError.prototype);
  }
}

/** Type guard for {@link NodeTimeoutError} (name-based; see above). */
export function isNodeTimeoutError(e: unknown): e is NodeTimeoutError {
  return e instanceof Error && e.name === 'NodeTimeoutError';
}

/**
 * Raised when a dynamic node fails.
 *
 * Caught by the parent node's NodeRunner to propagate the error.
 * Internal to the framework — not part of the public API.
 */
export class DynamicNodeFailError extends Error {
  readonly error: Error;
  readonly errorNodePath: string;

  /**
   * @param options.message Human-readable failure message.
   * @param options.error The underlying error thrown by the dynamic node.
   * @param options.errorNodePath The node path where the failure occurred.
   */
  constructor(options: {message: string; error: Error; errorNodePath: string}) {
    super(options.message);
    this.name = 'DynamicNodeFailError';
    this.error = options.error;
    this.errorNodePath = options.errorNodePath;
    Object.setPrototypeOf(this, DynamicNodeFailError.prototype);
  }
}

/** Type guard for {@link DynamicNodeFailError} (name-based; see above). */
export function isDynamicNodeFailError(e: unknown): e is DynamicNodeFailError {
  return e instanceof Error && e.name === 'DynamicNodeFailError';
}

/**
 * Raised when the invocation is aborted (e.g. its abort signal fires) while the
 * engine is waiting — currently during a node's retry backoff delay.
 *
 * Distinct from a node's own failure so a caller can tell "the invocation was
 * cancelled" apart from "the node threw".
 */
export class InvocationAbortedError extends Error {
  constructor(message = 'Invocation aborted.') {
    super(message);
    this.name = 'InvocationAbortedError';
    Object.setPrototypeOf(this, InvocationAbortedError.prototype);
  }
}

/** Type guard for {@link InvocationAbortedError} (name-based; see above). */
export function isInvocationAbortedError(
  e: unknown,
): e is InvocationAbortedError {
  return e instanceof Error && e.name === 'InvocationAbortedError';
}

/**
 * Raised when a node's input or output fails its declared schema.
 *
 * The underlying validation error (a `ZodError`, typically) carries the field
 * path but not the node it came from, which leaves a failure in a large graph
 * effectively unattributed. This wrapper names the node and which side of it
 * failed, and keeps the original error on `cause` for the full detail.
 */
export class NodeSchemaValidationError extends Error {
  readonly nodeName: string;
  /** Which side of the node failed: its `inputSchema` or its `outputSchema`. */
  readonly direction: 'input' | 'output';

  /**
   * @param options.nodeName The name of the node that failed validation.
   * @param options.direction Whether the input or the output failed.
   * @param options.cause The underlying validation error.
   */
  constructor(options: {
    nodeName: string;
    direction: 'input' | 'output';
    cause: unknown;
  }) {
    const schemaName =
      options.direction === 'input' ? 'inputSchema' : 'outputSchema';
    const detail =
      options.cause instanceof Error
        ? options.cause.message
        : String(options.cause);
    super(
      `Node '${options.nodeName}' ${options.direction} does not match its ` +
        `${schemaName}: ${detail}`,
      {cause: options.cause},
    );
    this.name = 'NodeSchemaValidationError';
    this.nodeName = options.nodeName;
    this.direction = options.direction;
    Object.setPrototypeOf(this, NodeSchemaValidationError.prototype);
  }
}

/** Type guard for {@link NodeSchemaValidationError} (name-based; see above). */
export function isNodeSchemaValidationError(
  e: unknown,
): e is NodeSchemaValidationError {
  return e instanceof Error && e.name === 'NodeSchemaValidationError';
}

/**
 * Raised when a replayed node waits past its deadline for the recorded
 * completion that should release it: the replay diverged from the recording.
 *
 * Proceeding instead would emit this turn's events in an order the session does
 * not record, which is the failure the replay barrier exists to prevent — so
 * the wait fails loudly rather than continuing.
 */
export class ReplayDivergenceError extends Error {
  /** The barrier key whose gate never opened. */
  readonly sequenceKey: string;
  /** The deadline, in milliseconds, that was exceeded. */
  readonly timeoutMs: number;

  /**
   * @param options.sequenceKey The barrier key that was waited on.
   * @param options.timeoutMs The deadline, in milliseconds, that was exceeded.
   */
  constructor(options: {sequenceKey: string; timeoutMs: number}) {
    // Wording matches `google/adk-python`'s so the two runtimes are greppable
    // together.
    super(
      `Replay divergence detected: Timed out waiting for sequence key ` +
        `'${options.sequenceKey}' to be unblocked.`,
    );
    this.name = 'ReplayDivergenceError';
    this.sequenceKey = options.sequenceKey;
    this.timeoutMs = options.timeoutMs;
    Object.setPrototypeOf(this, ReplayDivergenceError.prototype);
  }
}

/** Type guard for {@link ReplayDivergenceError} (name-based; see above). */
export function isReplayDivergenceError(
  e: unknown,
): e is ReplayDivergenceError {
  return e instanceof Error && e.name === 'ReplayDivergenceError';
}
