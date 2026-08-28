/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {BaseLlm} from '../../models/base_llm.js';
import {LLMRegistry} from '../../models/registry.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';

import {
  parseJsonFromModelText,
  requestJsonFromModel,
} from './model_json_request.js';
import {ToolConnectionMap, toToolConnectionMap} from './tool_connection_map.js';

const JSON_INDENT = 2;

function buildAnalysisPrompt(toolSchemasJson: string): string {
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
 * Asks a model which parameters carry state between a set of tools.
 *
 * For example, `get_ticket` consumes a `ticket_id` that `create_ticket`
 * produces, so a mock of `get_ticket` can answer with the entity that
 * `create_ticket` minted.
 *
 * @experimental
 */
@experimental
export class ToolConnectionAnalyzer {
  private readonly llm: BaseLlm;
  private readonly llmConfig: GenerateContentConfig;

  /**
   * @param llmName The model that performs the analysis.
   * @param llmConfig The configuration of that call.
   */
  constructor(llmName: string, llmConfig: GenerateContentConfig) {
    this.llm = LLMRegistry.newLlm(llmName);
    this.llmConfig = llmConfig;
  }

  /**
   * Analyzes how a set of tools connect to each other.
   *
   * A model that answers with something other than the documented JSON leaves
   * the run without a connection map rather than failing it.
   *
   * @param tools The tools to analyze. A tool with no declaration is skipped.
   * @return The connection map, empty when the model did not produce one.
   */
  async analyze(tools: BaseTool[]): Promise<ToolConnectionMap> {
    const toolSchemas = tools
      .map((tool) => tool._getDeclaration())
      .filter((declaration) => declaration !== undefined);
    const prompt = buildAnalysisPrompt(
      JSON.stringify(toolSchemas, null, JSON_INDENT),
    );

    const responseText = await requestJsonFromModel(
      this.llm,
      prompt,
      this.llmConfig,
    );
    const parsed = parseJsonFromModelText(responseText);
    if (parsed === undefined) {
      logger.warn(
        'Failed to parse tool connection analysis from LLM. Proceeding' +
          ` without connection map. LLM output: ${responseText}`,
      );
      return {statefulParameters: []};
    }
    return toToolConnectionMap(parsed);
  }
}
