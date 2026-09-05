/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {BaseLlm} from '../../models/base_llm.js';
import {LLMRegistry} from '../../models/registry.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';

import {
  generateSimulationText,
  stripJsonCodeFence,
} from './simulation_model.js';
import {
  parseToolConnectionMap,
  ToolConnectionMap,
} from './tool_connection_map.js';

const TOOL_CONNECTION_ANALYSIS_PROMPT_TEMPLATE = `
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
  {tool_schemas_json}

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

/**
 * Asks a model which parameters carry state between a set of tools.
 *
 * `get_ticket` consumes a `ticket_id` that `create_ticket` produced, and the
 * mock strategy needs to know that to keep the two calls consistent.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export class ToolConnectionAnalyzer {
  private readonly llm: BaseLlm;

  /**
   * @param modelName The model that performs the analysis.
   * @param modelConfig The configuration of that model call.
   */
  constructor(
    private readonly modelName: string,
    private readonly modelConfig: GenerateContentConfig,
  ) {
    this.llm = LLMRegistry.newLlm(modelName);
  }

  /**
   * Analyzes `tools` and reports the state they share.
   *
   * @param tools The tools to analyze. One without a declaration is skipped.
   * @returns The connection map, or an empty one when the model did not
   *     return JSON.
   * @throws {Error} When the model returned a well-formed JSON document of the
   *     wrong shape. adk-python raises here too.
   */
  async analyze(tools: BaseTool[]): Promise<ToolConnectionMap> {
    const toolSchemas = tools
      .map((tool) => tool._getDeclaration())
      .filter((declaration) => declaration !== undefined);
    const prompt = TOOL_CONNECTION_ANALYSIS_PROMPT_TEMPLATE.replace(
      '{tool_schemas_json}',
      () => JSON.stringify(toolSchemas, null, 2),
    );

    const rawText = await generateSimulationText({
      llm: this.llm,
      modelName: this.modelName,
      modelConfig: this.modelConfig,
      prompt,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonCodeFence(rawText));
    } catch (error) {
      logger.warn(
        'Failed to parse tool connection analysis from LLM. Proceeding' +
          ` without connection map. Error: ${error}\nLLM Output:\n${rawText}`,
      );
      return {statefulParameters: []};
    }
    return parseToolConnectionMap(parsed);
  }
}
