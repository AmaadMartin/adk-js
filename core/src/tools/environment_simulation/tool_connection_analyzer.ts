/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, GenerateContentConfig} from '@google/genai';

import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';

import {generateSimulationText, stripJsonFence} from './simulation_model.js';
import {
  ToolConnectionMap,
  parseToolConnectionMap,
} from './tool_connection_map.js';

/**
 * Builds the prompt that asks the model how a set of tools connects.
 *
 * The wording is adk-python's, including the snake_case keys the answer must
 * use.
 */
function buildToolConnectionAnalysisPrompt(toolSchemasJson: string): string {
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
 * Reads a connection map out of a model's raw answer.
 *
 * @param responseText The raw answer, fence and all.
 * @returns The connection map, or undefined when the answer is not JSON or
 *     does not carry a map.
 */
function readConnectionMap(
  responseText: string,
): ToolConnectionMap | undefined {
  let parsedResponse: unknown;
  try {
    parsedResponse = JSON.parse(stripJsonFence(responseText));
  } catch {
    return undefined;
  }
  return parseToolConnectionMap(parsedResponse);
}

/**
 * Asks a model which parameters carry state between a set of tools.
 *
 * `get_ticket` reads a ticket id that `create_ticket` produced, for example.
 * The analyzer records that relationship so a mock strategy can answer the
 * reader with the entity the creator invented.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
@experimental
export class ToolConnectionAnalyzer {
  private readonly model: string;
  private readonly modelConfig: GenerateContentConfig;

  /**
   * @param params.model The model to ask.
   * @param params.modelConfig The configuration of that model call.
   */
  constructor(params: {model: string; modelConfig: GenerateContentConfig}) {
    this.model = params.model;
    this.modelConfig = params.modelConfig;
  }

  /**
   * Analyzes how `tools` connect through their stateful parameters.
   *
   * An answer the analyzer cannot read costs stateful mocking rather than the
   * whole turn, so it degrades to an empty map instead of throwing.
   *
   * @param tools The tools to analyze. A tool with no declaration is skipped.
   * @returns The connection map, empty when the answer cannot be read.
   */
  async analyze(tools: BaseTool[]): Promise<ToolConnectionMap> {
    const toolSchemas: FunctionDeclaration[] = [];
    for (const tool of tools) {
      const declaration = tool._getDeclaration();
      if (declaration) {
        toolSchemas.push(declaration);
      }
    }

    const responseText = await generateSimulationText({
      model: this.model,
      modelConfig: this.modelConfig,
      prompt: buildToolConnectionAnalysisPrompt(
        JSON.stringify(toolSchemas, null, 2),
      ),
    });

    const connectionMap = readConnectionMap(responseText);
    if (!connectionMap) {
      logger.warn(
        'Failed to parse tool connection analysis from LLM. Proceeding' +
          ` without connection map.\nLLM Output:\n${responseText}`,
      );
      return {statefulParameters: []};
    }
    return connectionMap;
  }
}
