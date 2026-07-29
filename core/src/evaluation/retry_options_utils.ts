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

/** Number of attempts (including the original request) for eval LLM calls. */
const DEFAULT_RETRY_ATTEMPTS = 7;

/**
 * Default HTTP retry options injected into eval LLM requests.
 *
 * simplicity: the `@google/genai` `HttpRetryOptions` type only exposes
 * `attempts`, so only that field is set here. adk-python additionally sets
 * `initial_delay`, `max_delay`, `exp_base`, and `http_status_codes`, none of
 * which exist on the JS SDK's `HttpRetryOptions`. Upgrade path: add those
 * fields once the SDK exposes them.
 */
export const DEFAULT_HTTP_RETRY_OPTIONS: HttpRetryOptions = {
  attempts: DEFAULT_RETRY_ATTEMPTS,
};

/**
 * Adds {@link DEFAULT_HTTP_RETRY_OPTIONS} to the request only if retry options
 * are not already present.
 *
 * Mutating and idempotent: it ensures `config` and `config.httpOptions` exist,
 * then sets `retryOptions` only when it is falsy, never overriding
 * caller-supplied retry options.
 *
 * NOTE: Exported for assembling custom eval pipelines. The defaults it applies
 * are tuned for eval runs and may change.
 */
export function addDefaultRetryOptionsIfNotPresent(
  llmRequest: LlmRequest,
): void {
  llmRequest.config ??= {};
  llmRequest.config.httpOptions ??= {};
  llmRequest.config.httpOptions.retryOptions ??= DEFAULT_HTTP_RETRY_OPTIONS;
}

/**
 * A plugin that injects default HTTP retry options into every `LlmRequest`, so
 * that transient model-provider outages do not fail eval runs.
 *
 * NOTE: Exported for assembling custom eval pipelines. The defaults it applies
 * are tuned for eval runs and may change.
 */
export class EnsureRetryOptionsPlugin extends BasePlugin {
  override async beforeModelCallback({
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    addDefaultRetryOptionsIfNotPresent(llmRequest);
    return undefined;
  }
}
