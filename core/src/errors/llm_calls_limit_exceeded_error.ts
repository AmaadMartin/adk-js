/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thrown when an invocation makes more LLM calls than `RunConfig.maxLlmCalls`
 * allows.
 *
 * Mirrors `google/adk-python` `LlmCallsLimitExceededError`, so a caller can
 * recognise the runaway-invocation case without matching on the message.
 */
export class LlmCallsLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmCallsLimitExceededError';
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, LlmCallsLimitExceededError.prototype);
  }
}

/**
 * Type guard for {@link LlmCallsLimitExceededError}.
 *
 * Matches on `name` rather than `instanceof <subclass>` so it stays correct
 * when errors cross a package boundary (two copies of adk-js in one runtime
 * would fail an `instanceof` check between them).
 */
export function isLlmCallsLimitExceededError(
  e: unknown,
): e is LlmCallsLimitExceededError {
  return e instanceof Error && e.name === 'LlmCallsLimitExceededError';
}
