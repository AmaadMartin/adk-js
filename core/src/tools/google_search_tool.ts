/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {GenerateContentConfig} from '@google/genai';

import {
  isGemini1Model,
  isGeminiModel,
  isGeminiModelIdCheckDisabled,
} from '../utils/model_name.js';

import {ToolProcessLlmRequest} from './base_tool.js';
import {BuiltInTool} from './built_in_tool.js';

/**
 * Parameters for the {@link GoogleSearchTool} constructor.
 */
export interface GoogleSearchToolParams {
  /**
   * Whether to bypass the multi-tools limitation, so that the tool can be used
   * with other tools in the same agent.
   */
  bypassMultiToolsLimit?: boolean;

  /**
   * Optional model name to use for processing the LLM request. When set, this
   * model replaces the model on the incoming request.
   */
  model?: string;
}

/**
 * A built-in tool that is automatically invoked by Gemini 2 models to retrieve
 * search results from Google Search.
 *
 * This tool operates internally within the model and does not require or
 * perform local code execution.
 */
export class GoogleSearchTool extends BuiltInTool {
  readonly bypassMultiToolsLimit: boolean;
  readonly model?: string;

  constructor({
    bypassMultiToolsLimit = false,
    model,
  }: GoogleSearchToolParams = {}) {
    // The model runs this tool itself, so it reads neither the name nor the
    // description. Both match adk-python.
    super({name: 'google_search', description: 'google_search'});

    this.bypassMultiToolsLimit = bypassMultiToolsLimit;
    this.model = model;
  }

  protected override async applyBuiltInConfig({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    if (this.model !== undefined) {
      llmRequest.model = this.model;
    }

    if (!llmRequest.model && !llmRequest.isManagedAgent) {
      return;
    }

    const model = llmRequest.model ?? '';

    llmRequest.config = llmRequest.config || ({} as GenerateContentConfig);
    llmRequest.config.tools = llmRequest.config.tools || [];

    if (isGemini1Model(model)) {
      if (llmRequest.config.tools.length > 0 && !this.bypassMultiToolsLimit) {
        throw new Error(
          'Google search tool can not be used with other tools in Gemini 1.x.',
        );
      }

      llmRequest.config.tools.push({
        googleSearchRetrieval: {},
      });

      return;
    }

    if (
      isGeminiModel(model) ||
      isGeminiModelIdCheckDisabled() ||
      llmRequest.isManagedAgent
    ) {
      llmRequest.config.tools.push({
        googleSearch: {},
      });

      return;
    }

    throw new Error(
      `Google search tool is not supported for model ${llmRequest.model}`,
    );
  }
}

/**
 * A global instance of {@link GoogleSearchTool}.
 */
export const GOOGLE_SEARCH = new GoogleSearchTool();
