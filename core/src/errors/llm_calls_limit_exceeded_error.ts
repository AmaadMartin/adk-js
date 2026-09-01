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
 * catch the runaway-invocation case by type instead of matching on the message.
 */
export class LlmCallsLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmCallsLimitExceededError';
  }
}
