/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmRequest} from '../models/llm_request.js';

/**
 * Attempts an eval model call makes before it gives up, the original request
 * included.
 *
 * `@google/genai` 2.9.0 models the attempt count and nothing else on
 * `HttpRetryOptions`. adk-python additionally sets an initial delay, a maximum
 * delay, an exponential base and a status-code list, none of which the
 * TypeScript SDK declares.
 */
export const DEFAULT_RETRY_ATTEMPTS = 7;

/**
 * Stamps the default retry policy onto a request that carries none.
 *
 * A policy the caller set is left as it is, even a partial one, so an eval run
 * never overrides a deliberate choice.
 *
 * Intended for eval-system internal use. Do not depend on it directly.
 *
 * @param llmRequest The request to stamp. Modified in place.
 */
export function addDefaultRetryOptionsIfNotPresent(
  llmRequest: LlmRequest,
): void {
  llmRequest.config ??= {};
  llmRequest.config.httpOptions ??= {};
  llmRequest.config.httpOptions.retryOptions ??= {
    attempts: DEFAULT_RETRY_ATTEMPTS,
  };
}
