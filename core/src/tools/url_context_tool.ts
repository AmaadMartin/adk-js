/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  isGeminiModel,
  isGeminiModelIdCheckDisabled,
} from '../utils/model_name.js';

import {ToolProcessLlmRequest} from './base_tool.js';
import {BuiltInTool} from './built_in_tool.js';

/**
 * A built-in tool that allows Gemini models to retrieve content from URLs
 * provided in the conversation.
 *
 * This tool operates internally within the model and does not require or
 * perform local code execution.
 */
export class UrlContextTool extends BuiltInTool {
  constructor() {
    // The model runs this tool itself, so it reads neither the name nor the
    // description. Both match adk-python.
    super({name: 'url_context', description: 'url_context'});
  }

  protected override async applyBuiltInConfig({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    llmRequest.config = llmRequest.config || {};
    llmRequest.config.tools = llmRequest.config.tools || [];

    if (
      !isGeminiModel(llmRequest.model ?? '') &&
      !isGeminiModelIdCheckDisabled() &&
      !llmRequest.isManagedAgent
    ) {
      throw new Error(
        `URL context tool is not supported for model ${llmRequest.model}`,
      );
    }

    llmRequest.config.tools.push({urlContext: {}});
  }
}

/**
 * A global instance of {@link UrlContextTool}.
 */
export const URL_CONTEXT = new UrlContextTool();
