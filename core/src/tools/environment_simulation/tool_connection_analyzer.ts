/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, GenerateContentConfig} from '@google/genai';

import {experimental} from '../../utils/experimental.js';
import {parseFencedJson} from '../../utils/json_utils.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {SimulationModel} from './simulation_model.js';
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
  \`creatingTools\` and \`consumingTools\` based on the definitions above.

  **Example:** A \`create_ticket\` tool would be a creating tool for
  \`ticket_id\`. A \`get_ticket\` tool would be a consuming tool for
  \`ticket_id\`. A \`list_tickets\` tool that takes a \`user_id\` as input is a
  consuming tool for \`user_id\`.

  **Analyze the following tool schemas:**
  {toolSchemasJson}

  **Output Format:**
  Generate a JSON object with a single key, "statefulParameters", which is a
  list. Each item in the list must have these keys:
  - "parameterName": The name of the shared parameter (e.g., "ticket_id").
  - "creatingTools": A list of tools that create or modify this parameter's
    state.
  - "consumingTools": A list of tools that use this parameter as input for
    read-only operations.

  ONLY return the raw JSON object.
  Your response must start with '{' and end with '}'.
  `;

/**
 * Asks a model which parameters carry state between a set of tools.
 *
 * `get_ticket` consumes a ticket id that `create_ticket` produced, for example.
 * The analyzer collects those relationships so a mock strategy can answer a
 * consuming call with the entity a creating call invented.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
@experimental
export class ToolConnectionAnalyzer {
  private readonly simulationModel: SimulationModel;

  /**
   * @param params.model The model to ask.
   * @param params.modelConfig The configuration of that model call.
   */
  constructor(params: {model: string; modelConfig: GenerateContentConfig}) {
    this.simulationModel = new SimulationModel(
      params.model,
      params.modelConfig,
    );
  }

  /**
   * Analyzes how `tools` connect to each other.
   *
   * A model that answers with something other than the expected JSON degrades
   * to an empty map, so a failed analysis costs stateful mocking rather than
   * the whole turn.
   *
   * @param tools The tools to analyze. A tool with no declaration is skipped.
   * @returns The connection map, empty when the model's answer cannot be read.
   */
  async analyze(tools: BaseTool[]): Promise<ToolConnectionMap> {
    const toolSchemas: FunctionDeclaration[] = [];
    for (const tool of tools) {
      const declaration = tool._getDeclaration();
      if (declaration) {
        toolSchemas.push(declaration);
      }
    }
    const prompt = TOOL_CONNECTION_ANALYSIS_PROMPT_TEMPLATE.replace(
      '{toolSchemasJson}',
      () => JSON.stringify(toolSchemas, null, 2),
    );

    const responseText = await this.simulationModel.generateText(prompt);
    const connectionMap = parseToolConnectionMap(parseFencedJson(responseText));
    if (!connectionMap) {
      logger.warn(
        'Failed to parse tool connection analysis from LLM. Proceeding' +
          ` without connection map. LLM Output:\n${responseText}`,
      );
      return {statefulParameters: []};
    }
    return connectionMap;
  }
}
