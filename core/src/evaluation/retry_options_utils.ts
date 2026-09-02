/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HttpRetryOptions} from '@google/genai';

import {Context} from '../agents/context.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BasePlugin} from '../plugins/base_plugin.js';

/**
 * Attempts an eval model call makes before it gives up, the original request
 * included.
 */
export const DEFAULT_RETRY_ATTEMPTS = 7;

/**
 * Retry policy stamped onto an eval request that carries none.
 *
 * `@google/genai` 2.9.0 models the attempt count and nothing else on
 * `HttpRetryOptions`, and its client reads only that field, so the attempt
 * count is the whole policy. adk-python additionally sets an initial delay, a
 * maximum delay, an exponential base and a status-code list, none of which the
 * TypeScript SDK declares.
 */
const DEFAULT_HTTP_RETRY_OPTIONS: HttpRetryOptions = {
  attempts: DEFAULT_RETRY_ATTEMPTS,
};

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
  // A fresh copy per request, so a caller that later edits one request's
  // policy does not edit every other request's policy with it.
  llmRequest.config.httpOptions.retryOptions ??= {
    ...DEFAULT_HTTP_RETRY_OPTIONS,
  };
}

/**
 * Gives every eval model request a retry policy.
 *
 * A transient outage at the model provider would otherwise fail the eval case
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
