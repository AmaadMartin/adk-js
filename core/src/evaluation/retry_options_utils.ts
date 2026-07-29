/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HttpRetryOptions} from '@google/genai';

import {LlmRequest} from '../models/llm_request.js';

/**
 * Default HTTP retry options for eval model calls.
 *
 * Divergence from adk-python: the `@google/genai` (JS) `HttpRetryOptions` type
 * exposes only `attempts`; the Python SDK's `initialDelay`, `maxDelay`,
 * `expBase`, and `httpStatusCodes` have no JS-SDK equivalent, so only
 * `attempts` (matching the Python default of 7) is set here.
 */
const DEFAULT_HTTP_RETRY_OPTIONS: HttpRetryOptions = {attempts: 7};

/**
 * Adds default HTTP retry options to an `LlmRequest` if they are not present.
 *
 * NOTE: intended for eval-systems internal usage; do not take a direct
 * dependency on it.
 *
 * @param llmRequest The request to augment in place.
 */
export function addDefaultRetryOptionsIfNotPresent(
  llmRequest: LlmRequest,
): void {
  const config = llmRequest.config ?? {};
  const httpOptions = config.httpOptions ?? {};
  httpOptions.retryOptions =
    httpOptions.retryOptions ?? DEFAULT_HTTP_RETRY_OPTIONS;
  config.httpOptions = httpOptions;
  llmRequest.config = config;
}
