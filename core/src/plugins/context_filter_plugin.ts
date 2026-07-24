/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {Context} from '../agents/context.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {logger} from '../utils/logger.js';

import {BasePlugin} from './base_plugin.js';

const DEFAULT_PLUGIN_NAME = 'context_filter_plugin';
const MIN_REMOVE_AMOUNT = 1;

/**
 * Moves `splitIndex` left until function calls/responses stay paired.
 *
 * When truncating context, we must avoid keeping a `functionResponse` while
 * dropping its matching preceding `functionCall`. This fixes the orphaned
 * `functionResponse` problem described in google/adk-python#4027.
 *
 * @param contents - Full conversation contents in chronological order.
 * @param splitIndex - Candidate split index (keep `contents.slice(splitIndex)`).
 * @returns A (possibly smaller) split index that preserves call/response pairs.
 */
function adjustSplitIndexToAvoidOrphanedFunctionResponses(
  contents: Content[],
  splitIndex: number,
): number {
  const neededCallIds = new Set<string>();
  for (let i = contents.length - 1; i >= 0; i--) {
    const parts = contents[i].parts;
    if (parts) {
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j];
        if (part.functionResponse && part.functionResponse.id) {
          neededCallIds.add(part.functionResponse.id);
        }
        if (part.functionCall && part.functionCall.id) {
          neededCallIds.delete(part.functionCall.id);
        }
      }
    }

    if (i <= splitIndex && neededCallIds.size === 0) {
      return i;
    }
  }

  return 0;
}

/** Returns whether a content contains function responses. */
function isFunctionResponseContent(content: Content): boolean {
  const parts = content.parts;
  return parts != null && parts.some((part) => part.functionResponse != null);
}

/** Returns whether a content represents user input (not tool output). */
function isHumanUserContent(content: Content): boolean {
  return content.role === 'user' && !isFunctionResponseContent(content);
}

/**
 * Returns indices that begin a user-started invocation.
 *
 * An invocation begins with one or more consecutive human-user messages. Tool
 * outputs (function responses) are `role: 'user'` but are *not* considered
 * invocation starts.
 *
 * @param contents - Full conversation contents in chronological order.
 * @returns A list of indices where each index marks the start of an invocation.
 */
function getInvocationStartIndices(contents: Content[]): number[] {
  const invocationStartIndices: number[] = [];
  let previousWasHumanUser = false;
  for (let i = 0; i < contents.length; i++) {
    const isHumanUser = isHumanUserContent(contents[i]);
    if (isHumanUser && !previousWasHumanUser) {
      invocationStartIndices.push(i);
    }
    previousWasHumanUser = isHumanUser;
  }
  return invocationStartIndices;
}

/** Options for configuring a {@link ContextFilterPlugin}. */
export interface ContextFilterPluginOptions {
  /**
   * The number of last invocations to keep. An invocation starts with one or
   * more consecutive human-user messages and can contain multiple model turns
   * (e.g. tool calls) until the next human-user message starts a new
   * invocation. When undefined or <= 0, invocation-based truncation is skipped.
   */
  numInvocationsToKeep?: number;
  /** A predicate applied to the (possibly already-truncated) contents. */
  customFilter?: (contents: Content[]) => Content[];
  /** The plugin instance name. Defaults to `'context_filter_plugin'`. */
  name?: string;
  /**
   * How many additional invocations beyond `numInvocationsToKeep` must exist
   * before truncation triggers (hysteresis). Must be >= 1. Defaults to 1.
   */
  removeAmount?: number;
}

/** A plugin that filters the LLM context to reduce its size. */
export class ContextFilterPlugin extends BasePlugin {
  private readonly numInvocationsToKeep?: number;
  private readonly customFilter?: (contents: Content[]) => Content[];
  private readonly removeAmount: number;

  /**
   * @param options - Configuration for the plugin. An empty object yields a
   *   no-op plugin.
   * @throws {Error} If `removeAmount` is less than 1.
   */
  constructor(options: ContextFilterPluginOptions = {}) {
    const removeAmount = options.removeAmount ?? MIN_REMOVE_AMOUNT;
    if (removeAmount < MIN_REMOVE_AMOUNT) {
      throw new Error('removeAmount must be at least 1');
    }
    super(options.name ?? DEFAULT_PLUGIN_NAME);
    this.numInvocationsToKeep = options.numInvocationsToKeep;
    this.customFilter = options.customFilter;
    this.removeAmount = removeAmount;
  }

  /**
   * Filters the LLM request's context before it is sent to the model.
   *
   * The original `llmRequest.contents` is left untouched if any step throws.
   *
   * @returns Always `undefined`; the plugin only rewrites the request.
   */
  override async beforeModelCallback({
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    try {
      let contents = llmRequest.contents;

      if (this.numInvocationsToKeep != null && this.numInvocationsToKeep > 0) {
        const invocationStartIndices = getInvocationStartIndices(contents);
        if (
          invocationStartIndices.length >=
          this.numInvocationsToKeep + this.removeAmount
        ) {
          let splitIndex =
            invocationStartIndices[
              invocationStartIndices.length - this.numInvocationsToKeep
            ];
          splitIndex = adjustSplitIndexToAvoidOrphanedFunctionResponses(
            contents,
            splitIndex,
          );
          contents = contents.slice(splitIndex);
        }
      }

      if (this.customFilter) {
        contents = this.customFilter(contents);
      }

      llmRequest.contents = contents;
    } catch (e) {
      logger.error('Failed to reduce context for request', e);
    }

    return undefined;
  }
}
