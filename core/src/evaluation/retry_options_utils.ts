/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BasePlugin} from '../plugins/base_plugin.js';

/**
 * Attempts a model call is given before it fails, counting the original
 * request. Matches adk-python's eval default.
 *
 * `@google/genai`'s `HttpRetryOptions` declares only `attempts`, so the delay
 * and status-code fields adk-python sets have no counterpart here.
 */
export const DEFAULT_HTTP_RETRY_ATTEMPTS = 7;

/**
 * Adds the default HTTP retry options to a request that carries none.
 *
 * An existing `retryOptions` is left alone, so a caller that asked for its own
 * retry policy keeps it.
 *
 * Intended for eval-system internal use. Do not depend on it directly.
 *
 * @param llmRequest The request to complete, modified in place.
 */
export function addDefaultRetryOptionsIfNotPresent(
  llmRequest: LlmRequest,
): void {
  llmRequest.config ??= {};
  llmRequest.config.httpOptions ??= {};
  llmRequest.config.httpOptions.retryOptions ??= {
    attempts: DEFAULT_HTTP_RETRY_ATTEMPTS,
  };
}

/**
 * Gives every model request of an eval run a retry policy.
 *
 * A temporary outage at the model provider would otherwise fail the eval case
 * rather than the agent, so the inference step retries by default.
 *
 * Intended for eval-system internal use. Do not depend on it directly.
 */
export class EnsureRetryOptionsPlugin extends BasePlugin {
  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    addDefaultRetryOptionsIfNotPresent(params.llmRequest);
    return;
  }
}
