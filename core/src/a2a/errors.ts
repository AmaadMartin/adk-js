/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Errors raised by the A2A surface.
 *
 * Ported from `google/adk-python` `agents/remote_a2a_agent.py`, which declares
 * the same two types so a caller can tell a bad agent-card configuration apart
 * from a failure of the A2A client itself.
 */

/**
 * Raised when the agent card cannot be resolved: no card source was configured,
 * the card file is missing or unreadable, its contents are not valid JSON, or
 * the card could not be fetched from its URL.
 *
 * Signals a configuration fault. Retrying without changing the card source
 * fails the same way.
 */
export class AgentCardResolutionError extends Error {
  /**
   * @param message The failure description, surfaced unchanged to the caller.
   * @param options Standard error options; pass `cause` to keep the original
   *   failure reachable.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentCardResolutionError';
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, AgentCardResolutionError.prototype);
  }
}

/**
 * Type guard for {@link AgentCardResolutionError}.
 *
 * Matches on `name` rather than `instanceof <subclass>` so it stays correct when
 * errors cross a package boundary (two copies of adk-js in one runtime would
 * fail an `instanceof` check between them).
 *
 * @param e The value to test.
 * @return True when `e` is an {@link AgentCardResolutionError}.
 */
export function isAgentCardResolutionError(
  e: unknown,
): e is AgentCardResolutionError {
  return e instanceof Error && e.name === 'AgentCardResolutionError';
}

/**
 * Raised when an A2A client operation fails. `RemoteA2AAgent` raises it when it
 * cannot build a client from the resolved agent card.
 *
 * Signals a transport or remote condition rather than a local misconfiguration.
 */
export class A2AClientError extends Error {
  /**
   * @param message The failure description, surfaced unchanged to the caller.
   * @param options Standard error options; pass `cause` to keep the original
   *   failure reachable.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'A2AClientError';
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, A2AClientError.prototype);
  }
}

/**
 * Type guard for {@link A2AClientError}.
 *
 * Matches on `name` for the same reason as
 * {@link isAgentCardResolutionError}.
 *
 * @param e The value to test.
 * @return True when `e` is an {@link A2AClientError}.
 */
export function isA2AClientError(e: unknown): e is A2AClientError {
  return e instanceof Error && e.name === 'A2AClientError';
}
