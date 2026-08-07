/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HttpRetryOptions} from '@google/genai';

import {LlmRequest} from '../models/llm_request.js';

/**
 * Default retry options applied to judge-model requests.
 *
 * simplicity: the pinned `@google/genai` (`^2.9.0`) `HttpRetryOptions` type only
 * supports `attempts`, so only that field is set here. adk-python additionally
 * configures `initialDelay=5s`, `maxDelay=120s`, `expBase=2` and the retryable
 * HTTP status codes `408, 429, 500, 502, 503, 504`; those can be added once the
 * SDK's retry type exposes them.
 */
export const DEFAULT_HTTP_RETRY_OPTIONS: HttpRetryOptions = {
  attempts: 7,
};

/**
 * Adds default HTTP retry options to the request when none are present.
 *
 * This is an internal side effect used by the eval judge flow so that transient
 * outages with the model provider do not fail eval runs. It mutates
 * `llmRequest.config.httpOptions.retryOptions` in place.
 */
export function addDefaultRetryOptionsIfNotPresent(
  llmRequest: LlmRequest,
): void {
  llmRequest.config ??= {};
  llmRequest.config.httpOptions ??= {};
  llmRequest.config.httpOptions.retryOptions ??= DEFAULT_HTTP_RETRY_OPTIONS;
}
