/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {BaseLlm} from '../../../models/base_llm.js';
import {LLMRegistry} from '../../../models/registry.js';
import {experimental} from '../../../utils/experimental.js';
import {
  generateJsonText,
  isJsonObject,
  parseFencedJson,
} from '../../../utils/llm_utils.js';

import {toolSpecMockPrompt} from '../prompts.js';

import {BaseMockStrategy, MockRequest} from './base.js';
import {updateStateStore} from './state_store.js';

/** Mocks a tool response from the tool's own declaration. */
@experimental
export class ToolSpecMockStrategy extends BaseMockStrategy {
  /**
   * Resolved on first use rather than in the constructor: adk-js resolves a
   * Gemini model eagerly against its credentials, and a strategy built for a
   * tool that is never called must not require them.
   */
  private llm?: BaseLlm;

  /**
   * @param llmName The model used to generate mock responses.
   * @param llmConfig The generation config for the mock call.
   */
  constructor(
    private readonly llmName: string,
    private readonly llmConfig: GenerateContentConfig,
  ) {
    super();
  }

  async mock(request: MockRequest): Promise<Record<string, unknown>> {
    const {tool, args, toolConnectionMap, stateStore} = request;
    const declaration = tool._getDeclaration();
    if (!declaration) {
      return {
        status: 'error',
        error_message: 'Could not get tool declaration.',
      };
    }

    const prompt = toolSpecMockPrompt({
      environmentData: request.environmentData,
      tracing: request.tracing,
      toolConnectionMapJson: toolConnectionMap
        ? JSON.stringify(toolConnectionMap, null, 2)
        : "''",
      stateStoreJson: JSON.stringify(stateStore, null, 2),
      toolName: tool.name,
      toolDescription: tool.description,
      toolSchemaJson: JSON.stringify(declaration, null, 2),
      toolArgumentsJson: JSON.stringify(args, null, 2),
    });

    const responseText = await generateJsonText({
      llm: (this.llm ??= LLMRegistry.newLlm(this.llmName)),
      model: this.llmName,
      config: this.llmConfig,
      prompt,
    });

    const mockResponse = parseFencedJson(responseText);
    if (!isJsonObject(mockResponse)) {
      return {
        status: 'error',
        error_message: 'Failed to generate valid JSON mock response.',
        llm_output: responseText,
      };
    }

    updateStateStore({
      toolName: tool.name,
      mockResponse,
      stateStore,
      toolConnectionMap,
    });
    return mockResponse;
  }
}
