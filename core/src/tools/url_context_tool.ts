/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {GenerateContentConfig} from '@google/genai';

import {isGemini2OrAbove, isGeminiModel} from '../utils/model_name.js';

import {ToolProcessLlmRequest} from './base_tool.js';
import {BuiltInTool} from './built_in_tool.js';

/**
 * A built-in tool that allows Gemini 2+ models to retrieve content from URLs
 * provided in the conversation.
 *
 * This tool operates internally within the model and does not require or
 * perform local code execution.
 */
export class UrlContextTool extends BuiltInTool {
  constructor() {
    super({name: 'url_context', description: 'URL Context Tool'});
  }

  protected override async applyBuiltInConfig({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    // A managed agent resolves its tools server-side and so builds a request
    // with no model. The tool still has to enable itself on such a request.
    if (!llmRequest.model && !llmRequest.isManagedAgent) {
      return;
    }

    const model = llmRequest.model ?? '';

    // A managed agent's request names no model, so there is nothing to check.
    if (!llmRequest.isManagedAgent) {
      if (!isGeminiModel(model)) {
        throw new Error(`URL context tool is not supported for model ${model}`);
      }

      if (!isGemini2OrAbove(model)) {
        throw new Error(
          `URL context tool requires Gemini 2 or above, but got ${model}`,
        );
      }
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
