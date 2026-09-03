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

/**
 * Moves `splitIndex` left until function calls and responses stay paired.
 *
 * When truncating context, we must avoid keeping a `functionResponse` while
 * dropping its matching preceding `functionCall`.
 *
 * @param contents Full conversation contents in chronological order.
 * @param splitIndex Candidate split index (keep `contents[splitIndex:]`).
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
        if (part.functionResponse?.id) {
          neededCallIds.add(part.functionResponse.id);
        }
        if (part.functionCall?.id) {
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
 * Returns the indices that begin a user-started invocation.
 *
 * An invocation begins with one or more consecutive user messages. Tool outputs
 * (function responses) carry `role: 'user'` but are *not* invocation starts.
 *
 * @param contents Full conversation contents in chronological order.
 * @returns The index of the first content of each invocation.
 */
function getInvocationStartIndices(contents: Content[]): number[] {
  const invocationStartIndices: number[] = [];
  let previousWasHumanUser = false;
  contents.forEach((content, i) => {
    const isHumanUser = isHumanUserContent(content);
    if (isHumanUser && !previousWasHumanUser) {
      invocationStartIndices.push(i);
    }
    previousWasHumanUser = isHumanUser;
  });
  return invocationStartIndices;
}

/**
 * Options for configuring {@link ContextFilterPlugin}.
 */
export interface ContextFilterPluginOptions {
  /**
   * The number of last invocations to keep. An invocation starts with one or
   * more consecutive user messages and can contain multiple model turns (for
   * example tool calls) until the next user message starts a new invocation.
   *
   * Leaving this undefined, or setting it to 0 or less, skips truncation.
   */
  numInvocationsToKeep?: number;

  /**
   * A function that filters the context after truncation.
   */
  customFilter?: (contents: Content[]) => Content[];

  /**
   * Plugin instance identifier.
   * Defaults to 'context_filter_plugin'.
   */
  name?: string;

  /**
   * The number of extra invocations that must accumulate before truncation
   * runs. Truncation always keeps `numInvocationsToKeep` invocations; this
   * option only decides how often it runs. Must be at least 1.
   * Defaults to 1.
   */
  removeAmount?: number;
}

/**
 * A plugin that filters the LLM context to reduce its size.
 *
 * The plugin rewrites `llmRequest.contents` for a single model call. It leaves
 * the persisted session untouched, and it never short-circuits the call.
 *
 * @example
 * ```typescript
 * import {ContextFilterPlugin} from '@google/adk';
 *
 * const plugin = new ContextFilterPlugin({
 *   numInvocationsToKeep: 3,
 *   removeAmount: 2,
 *   customFilter: (contents) => contents.filter((c) => c.role !== 'model'),
 * });
 * ```
 */
export class ContextFilterPlugin extends BasePlugin {
  private readonly numInvocationsToKeep?: number;
  private readonly customFilter?: (contents: Content[]) => Content[];
  private readonly removeAmount: number;

  /**
   * Initializes the {@link ContextFilterPlugin}.
   *
   * @param options - Configuration options for the plugin.
   */
  constructor(options: ContextFilterPluginOptions = {}) {
    super(options.name ?? DEFAULT_PLUGIN_NAME);

    const removeAmount = options.removeAmount ?? 1;
    if (removeAmount < 1) {
      throw new Error('removeAmount must be at least 1.');
    }

    this.numInvocationsToKeep = options.numInvocationsToKeep;
    this.customFilter = options.customFilter;
    this.removeAmount = removeAmount;
  }

  /** Filters the request's context before it is sent to the model. */
  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const {llmRequest} = params;
    try {
      let contents = llmRequest.contents;

      if (this.numInvocationsToKeep != null && this.numInvocationsToKeep > 0) {
        const invocationStartIndices = getInvocationStartIndices(contents);
        if (
          invocationStartIndices.length >=
          this.numInvocationsToKeep + this.removeAmount
        ) {
          const candidateIndex =
            invocationStartIndices[
              invocationStartIndices.length - this.numInvocationsToKeep
            ];
          const splitIndex = adjustSplitIndexToAvoidOrphanedFunctionResponses(
            contents,
            candidateIndex,
          );
          contents = contents.slice(splitIndex);
        }
      }

      if (this.customFilter) {
        contents = this.customFilter(contents);
      }

      llmRequest.contents = contents;
    } catch (e: unknown) {
      logger.error('Failed to reduce context for request', e);
    }

    return undefined;
  }
}
