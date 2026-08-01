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
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';

import {
  generateSimulationText,
  parseFencedJson,
} from './simulation_llm_utils.js';
import {
  ToolConnectionMap,
  ToolConnectionMapSchema,
} from './tool_connection_map.js';

function toolConnectionAnalysisPrompt(toolSchemasJson: string): string {
  return `
  You are an expert software architect analyzing a set of tools to understand
  stateful dependencies. Your task is to identify parameters that act as
  stateful identifiers (like IDs) and classify the tools that interact with
  them.

  **Definitions:**
  - A **"creating tool"** is a tool that creates a new resource or makes a
    significant state change to an existing one (e.g., creating, updating,
    canceling, or deleting). Tool names like \`create_account\`, \`cancel_order\`,
    or \`update_price\` are strong indicators. These tools are responsible for
    generating or modifying the state associated with an ID.
  - A **"consuming tool"** is a tool that uses a resource's ID to retrieve
    information without changing its state. Tool names like \`get_user\`,
    \`list_events\`, or \`find_order\` are strong indicators.

  **Your Goal:**
  Analyze the following tool schemas and identify the shared, stateful
  parameters (like \`user_id\`, \`order_id\`, etc.).

  For each stateful parameter you identify, classify the tools into
  \`creating_tools\` and \`consuming_tools\` based on the definitions above.

  **Example:** A \`create_ticket\` tool would be a \`creating_tool\` for
  \`ticket_id\`. A \`get_ticket\` tool would be a \`consuming_tool\` for
  \`ticket_id\`. A \`list_tickets\` tool that takes a \`user_id\` as input is a
  \`consuming_tool\` for \`user_id\`.

  **Analyze the following tool schemas:**
  ${toolSchemasJson}

  **Output Format:**
  Generate a JSON object with a single key, "stateful_parameters", which is a
  list. Each item in the list must have these keys:
  - "parameter_name": The name of the shared parameter (e.g., "ticket_id").
  - "creating_tools": A list of tools that create or modify this parameter's
    state.
  - "consuming_tools": A list of tools that use this parameter as input for
    read-only operations.

  ONLY return the raw JSON object.
  Your response must start with '{' and end with '}'.
  `;
}

/**
 * Uses an LLM to analyze stateful connections between tools.
 *
 * For example, `get_ticket` consumes a `ticket_id` created by `create_ticket`;
 * the analyzer produces the list of such connections.
 */
@experimental
export class ToolConnectionAnalyzer {
  private readonly llm: BaseLlm;

  /**
   * @param llmName The model used to run the analysis.
   * @param llmConfig The generation config for the analysis call.
   */
  constructor(
    private readonly llmName: string,
    private readonly llmConfig: GenerateContentConfig,
  ) {
    this.llm = LLMRegistry.newLlm(llmName);
  }

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
    const prompt = toolConnectionAnalysisPrompt(
      JSON.stringify(toolSchemas, null, 2),
    );

    const responseText = await generateSimulationText({
      llm: this.llm,
      model: this.llmName,
      config: this.llmConfig,
      prompt,
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
