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
const DEFAULT_REMOVE_AMOUNT = 1;

/** Options for configuring {@link ContextFilterPlugin}. */
export interface ContextFilterPluginOptions {
  /**
   * The number of last invocations to keep. An invocation starts with one or
   * more consecutive user messages and can contain several model turns (for
   * example tool calls) until the next user message starts a new invocation.
   *
   * Leaving this undefined, or setting it to 0 or less, skips truncation.
   */
  numInvocationsToKeep?: number;

  /** A function that filters the context after truncation. */
  customFilter?: (contents: Content[]) => Content[];

  /** Plugin instance identifier. Defaults to `context_filter_plugin`. */
  name?: string;

  /**
   * The number of extra invocations that must accumulate before truncation
   * runs. Truncation starts once the conversation holds
   * `numInvocationsToKeep + removeAmount` invocations. Must be at least 1.
   * Defaults to 1.
   */
  removeAmount?: number;
}

/**
 * Moves `splitIndex` left until every kept function response keeps its call.
 *
 * Dropping a `functionCall` while keeping its `functionResponse` leaves the
 * model with an answer to a question it cannot see.
 *
 * @param contents The full conversation, in chronological order.
 * @param splitIndex The candidate split index; `contents.slice(splitIndex)` is
 *     the kept window.
 * @returns A split index at or below `splitIndex` that keeps every pair whole.
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

/** Returns whether a content carries tool output. */
function isFunctionResponseContent(content: Content): boolean {
  return (
    content.parts?.some((part) => part.functionResponse !== undefined) ?? false
  );
}

/** Returns whether a content is a human turn rather than tool output. */
function isHumanUserContent(content: Content): boolean {
  return content.role === 'user' && !isFunctionResponseContent(content);
}

/**
 * Returns the indices that begin a user-started invocation.
 *
 * A run of consecutive human messages starts one invocation, not several. Tool
 * output carries `role: 'user'` but never starts an invocation.
 *
 * @param contents The full conversation, in chronological order.
 * @returns The index of the first content of each invocation.
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

/**
 * A plugin that shrinks the context of a single model request.
 *
 * It keeps the last `numInvocationsToKeep` invocations, then applies an
 * optional `customFilter`. The stored session is untouched: the plugin rewrites
 * one request and nothing else.
 *
 * Example:
 * ```typescript
 * const runner = new InMemoryRunner({
 *   agent: new LlmAgent({name: 'chat', model: 'gemini-2.5-flash'}),
 *   plugins: [new ContextFilterPlugin({numInvocationsToKeep: 3})],
 * });
 * ```
 */
export class ContextFilterPlugin extends BasePlugin {
  private readonly numInvocationsToKeep?: number;
  private readonly customFilter?: (contents: Content[]) => Content[];
  private readonly removeAmount: number;

  constructor(options: ContextFilterPluginOptions = {}) {
    const removeAmount = options.removeAmount ?? DEFAULT_REMOVE_AMOUNT;
    if (removeAmount < 1) {
      throw new Error('removeAmount must be at least 1.');
    }
    super(options.name ?? DEFAULT_PLUGIN_NAME);
    this.numInvocationsToKeep = options.numInvocationsToKeep;
    this.customFilter = options.customFilter;
    this.removeAmount = removeAmount;
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    try {
      let contents = params.llmRequest.contents;

      if (
        this.numInvocationsToKeep !== undefined &&
        this.numInvocationsToKeep > 0
      ) {
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

      params.llmRequest.contents = contents;
    } catch (e: unknown) {
      logger.error('Failed to reduce context for request', e);
    }

    return undefined;
  }
}
