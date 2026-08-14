/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Part} from '@google/genai';

import type {Context} from '../agents/context.js';
import type {LlmRequest} from '../models/llm_request.js';
import type {LlmResponse} from '../models/llm_response.js';
import type {BaseTool} from '../tools/base_tool.js';
import {BasePlugin} from './base_plugin.js';

/**
 * The temp-state key under which parts returned by tools are buffered until the
 * next model call. Must byte-match the adk-python key so behaviour is identical
 * across languages.
 */
export const PARTS_RETURNED_BY_TOOLS_ID = 'temp:PARTS_RETURNED_BY_TOOLS_ID';

/**
 * Discriminator fields of a `@google/genai` `Part`. `Part` is a structural
 * interface with no runtime constructor, so it cannot be detected with
 * `instanceof`; presence of one of these fields identifies a `Part`.
 */
const PART_KEYS = [
  'text',
  'inlineData',
  'fileData',
  'functionCall',
  'functionResponse',
  'executableCode',
  'codeExecutionResult',
  'videoMetadata',
  'thought',
  'thoughtSignature',
] as const;

/**
 * Structurally detects a `@google/genai` `Part`. Because TypeScript uses
 * structural typing, a plain result object that happens to carry a `Part` field
 * name (e.g. `{text: '...'}`) is treated as a `Part`; this matches the intended
 * use where tools opt in by returning genai `Part`s.
 */
function isPart(value: unknown): value is Part {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    PART_KEYS.some((key) => key in value)
  );
}

/**
 * A plugin that lets function tools return multimodal content (a `Part` or a
 * list of `Part`s, e.g. images) directly, surfacing those parts to the next LLM
 * turn.
 *
 * Should be removed in favor of directly supporting `FunctionResponsePart` when
 * these are supported outside of the computer use tool. For context see:
 * https://github.com/google/adk-python/issues/3064
 */
export class MultimodalToolResultsPlugin extends BasePlugin {
  /**
   * @param name The name of the plugin instance.
   */
  constructor(name = 'multimodal_tool_results_plugin') {
    super(name);
  }

  /**
   * Buffers parts returned by the tool in the tool context. Later these are
   * passed to the LLM's context as-is by {@link beforeModelCallback}. No-op if
   * the tool does not return a `Part` or a non-empty array of `Part`s, in which
   * case the original result is returned unchanged.
   */
  override async afterToolCallback({
    toolContext,
    result,
  }: {
    tool: BaseTool;
    toolArgs: Record<string, unknown>;
    toolContext: Context;
    result: Record<string, unknown>;
  }): Promise<Record<string, unknown> | undefined> {
    const value = result as unknown;
    const single = isPart(value);
    const isPartArray =
      Array.isArray(value) && value.length > 0 && isPart(value[0]);
    if (!single && !isPartArray) {
      return result;
    }

    const parts: Part[] = single ? [value] : (value as Part[]);
    const existing = toolContext.state.get<Part[]>(PARTS_RETURNED_BY_TOOLS_ID);
    toolContext.state.set(
      PARTS_RETURNED_BY_TOOLS_ID,
      existing ? [...existing, ...parts] : parts,
    );
    return undefined;
  }

  /**
   * Attaches the buffered parts to the final content of the request and clears
   * the buffer. No-op when the request has no contents or the buffer is empty;
   * never short-circuits the model call.
   */
  override async beforeModelCallback({
    callbackContext,
    llmRequest,
  }: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    const {contents} = llmRequest;
    if (!contents || contents.length === 0) {
      return undefined;
    }

    const savedParts = callbackContext.state.get<Part[]>(
      PARTS_RETURNED_BY_TOOLS_ID,
    );
    if (savedParts && savedParts.length > 0) {
      const lastContent = contents[contents.length - 1];
      lastContent.parts = [...(lastContent.parts ?? []), ...savedParts];
      callbackContext.state.set(PARTS_RETURNED_BY_TOOLS_ID, []);
    }
    return undefined;
  }
}
