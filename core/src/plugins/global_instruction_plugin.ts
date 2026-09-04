/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, ContentUnion, createPartFromText, Part} from '@google/genai';
import {Context} from '../agents/context.js';
import {injectSessionState} from '../agents/instructions.js';
import {InstructionProvider} from '../agents/llm_agent.js';
import {ReadonlyContext} from '../agents/readonly_context.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {BasePlugin} from './base_plugin.js';

/**
 * Narrows a genai `ContentUnion` member to `Content`.
 *
 * `Content` is an interface, so the guard keys on the `parts` property instead
 * of a runtime class. The exported guard in `workflow/base_node.ts` also
 * requires `parts` to be an array, which would send a `Content` whose `parts`
 * is `undefined` down the `Part` branch.
 */
function isContent(value: Content | Part): value is Content {
  return 'parts' in value;
}

/**
 * Prepends `prefix` to `existing`, preserving the SDK content shape it arrives
 * in.
 *
 * A `Content` keeps its `role` and its other parts and gains a leading text
 * part. Every other shape becomes a string or a `PartUnion[]`. The caller's
 * `Content` is never mutated.
 *
 * Mirrors `_prepend_instruction` in `google/adk-python`
 * `src/google/adk/plugins/global_instruction_plugin.py`.
 */
function prependInstruction(
  prefix: string,
  existing: ContentUnion,
): ContentUnion {
  if (typeof existing === 'string') {
    return `${prefix}\n\n${existing}`;
  }
  if (Array.isArray(existing)) {
    return [prefix, ...existing];
  }
  if (isContent(existing)) {
    return {
      ...existing,
      parts: [createPartFromText(prefix), ...(existing.parts ?? [])],
    };
  }
  return [prefix, existing];
}

/**
 * Plugin that provides global instructions functionality at the App level.
 *
 * This plugin replaces the deprecated globalInstruction field on LlmAgent.
 * Global instructions are applied to all agents in the application, providing
 * a consistent way to set application-wide instructions, identity, or
 * personality.
 *
 * The plugin operates through the beforeModelCallback, allowing it to modify
 * LLM requests before they are sent to the model.
 */
export class GlobalInstructionPlugin extends BasePlugin {
  private readonly globalInstruction?: string | InstructionProvider;

  /**
   * Initializes the GlobalInstructionPlugin.
   *
   * @param globalInstruction The instruction to apply globally. Can be a string
   *     or an InstructionProvider function that takes ReadonlyContext and
   *     returns a string (sync or async).
   * @param name The name of the plugin (defaults to 'global_instruction').
   */
  constructor(
    globalInstruction?: string | InstructionProvider,
    name = 'global_instruction',
  ) {
    super(name);
    this.globalInstruction = globalInstruction;
  }

  override async beforeModelCallback(params: {
    callbackContext: Context;
    llmRequest: LlmRequest;
  }): Promise<LlmResponse | undefined> {
    if (!this.globalInstruction) {
      return;
    }

    const readonlyContext = new ReadonlyContext(
      params.callbackContext.invocationContext,
    );
    const finalGlobalInstruction =
      await this.resolveGlobalInstruction(readonlyContext);

    if (!finalGlobalInstruction) {
      return;
    }

    if (!params.llmRequest.config) {
      params.llmRequest.config = {};
    }

    const existingInstruction = params.llmRequest.config.systemInstruction;

    if (
      !existingInstruction ||
      (Array.isArray(existingInstruction) && existingInstruction.length === 0)
    ) {
      params.llmRequest.config.systemInstruction = finalGlobalInstruction;
      return;
    }

    params.llmRequest.config.systemInstruction = prependInstruction(
      finalGlobalInstruction,
      existingInstruction,
    );

    return;
  }

  private async resolveGlobalInstruction(
    readonlyContext: ReadonlyContext,
  ): Promise<string> {
    if (typeof this.globalInstruction === 'string') {
      return await injectSessionState(this.globalInstruction, readonlyContext);
    }
    return await this.globalInstruction!(readonlyContext);
  }
}
