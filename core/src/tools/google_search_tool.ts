/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {GenerateContentConfig} from '@google/genai';

import {isGemini1Model, isGeminiModel} from '../utils/model_name.js';

import {ToolProcessLlmRequest} from './base_tool.js';
import {BuiltInTool} from './built_in_tool.js';

const GOOGLE_SEARCH_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.googleSearchTool',
);

/**
 * Type guard to check if an object is an instance of GoogleSearchTool.
 * @param obj The object to check.
 * @returns True if the object is an instance of GoogleSearchTool, false
 *     otherwise.
 */
export function isGoogleSearchTool(obj: unknown): obj is GoogleSearchTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    GOOGLE_SEARCH_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[GOOGLE_SEARCH_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/** Parameters for the {@link GoogleSearchTool} constructor. */
export interface GoogleSearchToolParams {
  /**
   * Whether to bypass the multi-tools limitation, so that the tool can be used
   * with other tools in the same agent.
   */
  bypassMultiToolsLimit?: boolean;
}

/**
 * A built-in tool that is automatically invoked by Gemini 2 models to retrieve
 * search results from Google Search.
 *
 * This tool operates internally within the model and does not require or
 * perform local code execution.
 */
export class GoogleSearchTool extends BuiltInTool {
  /** A unique symbol to identify ADK Google Search tool class. */
  readonly [GOOGLE_SEARCH_TOOL_SIGNATURE_SYMBOL] = true;

  readonly bypassMultiToolsLimit: boolean;

  constructor({bypassMultiToolsLimit = false}: GoogleSearchToolParams = {}) {
    super({name: 'google_search', description: 'Google Search Tool'});
    this.bypassMultiToolsLimit = bypassMultiToolsLimit;
  }

  protected override async applyBuiltInConfig({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    if (!llmRequest.model) {
      return;
    }

    llmRequest.config = llmRequest.config || ({} as GenerateContentConfig);
    llmRequest.config.tools = llmRequest.config.tools || [];

    if (isGemini1Model(llmRequest.model)) {
      if (llmRequest.config.tools.length > 0) {
        throw new Error(
          'Google search tool can not be used with other tools in Gemini 1.x.',
        );
      }

      llmRequest.config.tools.push({
        googleSearchRetrieval: {},
      });

      return;
    }

    if (isGeminiModel(llmRequest.model)) {
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
