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

/** State/response-metadata key under which the request id is stored. */
export const LLM_REQUEST_ID_KEY = '__llm_request_key__';

/**
 * A plugin that intercepts each `LlmRequest` and couples it with the resulting
 * `LlmResponse`, so eval systems can recover the request context (instructions,
 * available tools) from a response.
 *
 * Each request is cached under a unique id; the id is stamped onto the
 * response's `customMetadata`, letting {@link getModelRequest} look the request
 * back up from a response.
 *
 * NOTE: This is intended for internal eval usage; do not depend on it directly.
 */
export class RequestIntercepterPlugin extends BasePlugin {
  private readonly llmRequestsCache = new Map<string, LlmRequest>();

  override async beforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const requestId = randomUUID();
    this.llmRequestsCache.set(requestId, llmRequest);
    callbackContext.state.set(LLM_REQUEST_ID_KEY, requestId);
    return undefined;
  }

  override async afterModelCallback({
    callbackContext,
    llmResponse,
  }: {
    callbackContext: Context;
    llmResponse: LlmResponse;
  }): Promise<LlmResponse | undefined> {
    if (callbackContext.state.has(LLM_REQUEST_ID_KEY)) {
      llmResponse.customMetadata ??= {};
      llmResponse.customMetadata[LLM_REQUEST_ID_KEY] =
        callbackContext.state.get(LLM_REQUEST_ID_KEY);
    }
    return undefined;
  }

  /**
   * Returns the cached `LlmRequest` for the given response, or `undefined` if
   * the response carries no request id or the id is not cached.
   */
  getModelRequest(llmResponse: LlmResponse): LlmRequest | undefined {
    const requestId = llmResponse.customMetadata?.[LLM_REQUEST_ID_KEY];
    if (typeof requestId !== 'string') {
      return undefined;
    }

    const cachedRequest = this.llmRequestsCache.get(requestId);
    if (cachedRequest === undefined) {
      logger.warn(`\`${requestId}\` not found in llmRequestsCache.`);
      return undefined;
    }
    return cachedRequest;
  }
}
