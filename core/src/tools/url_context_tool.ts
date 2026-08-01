/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {GenerateContentConfig} from '@google/genai';

import {
  isGemini1Model,
  isGemini2OrAbove,
  isGeminiModel,
  isGeminiModelIdCheckDisabled,
} from '../utils/model_name.js';

import {BaseTool, ToolProcessLlmRequest} from './base_tool.js';

/**
 * A built-in tool that allows Gemini 2+ models to retrieve content from URLs
 * provided in the conversation.
 *
 * This tool operates internally within the model and does not require or
 * perform local code execution.
 */
export class UrlContextTool extends BaseTool {
  constructor() {
    super({name: 'url_context', description: 'URL Context Tool'});
  }

  runAsync(): Promise<unknown> {
    // This is a built-in tool on server side, it's triggered by setting the
    // corresponding request parameters.
    return Promise.resolve();
  }

  override async processLlmRequest({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    if (!llmRequest.model) {
      return;
    }

    // The model-id escape hatch does not unlock Gemini 1.x, which does not
    // support url_context at all.
    const bypassModelCheck =
      isGeminiModelIdCheckDisabled() && !isGemini1Model(llmRequest.model);

    if (!isGeminiModel(llmRequest.model) && !bypassModelCheck) {
      throw new Error(
        `URL context tool is not supported for model ${llmRequest.model}`,
      );
    }

    if (!isGemini2OrAbove(llmRequest.model) && !bypassModelCheck) {
      throw new Error(
        `URL context tool requires Gemini 2 or above, but got ${llmRequest.model}`,
      );
    }

    llmRequest.config = llmRequest.config || ({} as GenerateContentConfig);
    llmRequest.config.tools = llmRequest.config.tools || [];
    llmRequest.config.tools.push({
      urlContext: {},
    });
  }
}

/**
 * A global instance of {@link UrlContextTool}.
 */
export const URL_CONTEXT = new UrlContextTool();
