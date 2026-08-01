/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {BaseLlm} from '../../models/base_llm.js';
import {LLMRegistry} from '../../models/registry.js';
import {camelCaseKeys} from '../../utils/case_utils.js';
import {experimental} from '../../utils/experimental.js';
import {generateJsonText, parseFencedJson} from '../../utils/llm_utils.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';

import {toolConnectionAnalysisPrompt} from './prompts.js';
import {
  ToolConnectionMap,
  ToolConnectionMapSchema,
} from './tool_connection_map.js';

/**
 * Uses an LLM to analyze stateful connections between tools.
 *
 * For example, `get_ticket` consumes a `ticket_id` created by `create_ticket`;
 * the analyzer produces the list of such connections.
 */
@experimental
export class ToolConnectionAnalyzer {
  /**
   * Resolved on first use rather than in the constructor: adk-js resolves a
   * Gemini model eagerly against its credentials, and a simulation that only
   * injects responses must not require credentials for a model it never calls.
   */
  private llm?: BaseLlm;

  /**
   * @param llmName The model used to run the analysis.
   * @param llmConfig The generation config for the analysis call.
   */
  constructor(
    private readonly llmName: string,
    private readonly llmConfig: GenerateContentConfig,
  ) {}

  /**
   * Analyzes a list of tools and returns the map of their connections.
   *
   * @param tools The tools to analyze. Tools without a declaration are
   *     excluded from the prompt.
   * @returns The connection map, or an empty one when the model returns
   *     something that is not valid JSON.
   */
  async analyze(tools: BaseTool[]): Promise<ToolConnectionMap> {
    const toolSchemas = tools
      .map((tool) => tool._getDeclaration())
      .filter((declaration) => declaration !== undefined);

    const responseText = await generateJsonText({
      llm: (this.llm ??= LLMRegistry.newLlm(this.llmName)),
      model: this.llmName,
      config: this.llmConfig,
      prompt: toolConnectionAnalysisPrompt(
        JSON.stringify(toolSchemas, null, 2),
      ),
    });

    const responseJson = parseFencedJson(responseText);
    if (responseJson === undefined) {
      logger.warn(
        'Failed to parse tool connection analysis from LLM. Proceeding' +
          ` without connection map. LLM Output:\n${responseText}`,
      );
      return {statefulParameters: []};
    }
    return ToolConnectionMapSchema.parse(camelCaseKeys(responseJson));
  }
}
