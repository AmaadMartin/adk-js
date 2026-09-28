/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BasePlugin} from '../plugins/base_plugin.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

/**
 * Key under which the id of an intercepted request is carried, both in the
 * callback state and in the response's `customMetadata`.
 */
export const LLM_REQUEST_ID_KEY = '__llm_request_key__';

/**
 * How many requests the intercepter keeps. The oldest entry is dropped once
 * the cache is full.
 *
 * adk-python's cache is unbounded. An eval run over a large eval set makes one
 * entry per model call, each holding a full request, so the cache is capped
 * here.
 */
export const MAX_CACHED_REQUESTS = 1000;

/**
 * Couples the request sent to a model with the response that came back.
 *
 * Autorater-backed metrics grade against what the model was shown: its
 * instructions and the tools it could call. That lives on the `LlmRequest`,
 * which never reaches the eval system, only the response does. This plugin
 * caches each request under a fresh id, stamps the id onto the response's
 * `customMetadata`, and hands the request back through
 * {@link getModelRequest}.
 *
 * Intended for eval-system internal use. Do not depend on it directly.
 */
export class RequestIntercepterPlugin extends BasePlugin {
  private readonly llmRequestsCache = new Map<string, LlmRequest>();

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const requestId = randomUUID();
    if (this.llmRequestsCache.size >= MAX_CACHED_REQUESTS) {
      const oldestId = this.llmRequestsCache.keys().next().value;
      if (oldestId !== undefined) {
        this.llmRequestsCache.delete(oldestId);
      }
    }
    this.llmRequestsCache.set(requestId, params.llmRequest);
    params.callbackContext.state.set(LLM_REQUEST_ID_KEY, requestId);
    return;
  }

  override async afterModelCallback(params: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    const requestId =
      params.callbackContext.state.get<string>(LLM_REQUEST_ID_KEY);
    if (requestId !== undefined) {
      params.llmResponse.customMetadata ??= {};
      params.llmResponse.customMetadata[LLM_REQUEST_ID_KEY] = requestId;
    }
    return;
  }

  /**
   * Returns the request that produced `llmResponse`.
   *
   * @param llmResponse A response this plugin stamped on its way out.
   * @returns The originating request, or `undefined` when the response carries
   *     no id or the cache has since dropped it.
   */
  getModelRequest(llmResponse: LlmResponse): LlmRequest | undefined {
    const requestId = llmResponse.customMetadata?.[LLM_REQUEST_ID_KEY];
    if (typeof requestId !== 'string') {
      return undefined;
    }
    const llmRequest = this.llmRequestsCache.get(requestId);
    if (llmRequest === undefined) {
      logger.warn(`\`${requestId}\` not found in llm_request_cache.`);
    }
    return llmRequest;
  }
}
