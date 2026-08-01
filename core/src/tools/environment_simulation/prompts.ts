/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds the prompt asking a model to classify the stateful parameters shared
 * between a set of tools.
 *
 * @param toolSchemasJson The tool declarations, serialized as JSON.
 */
export function toolConnectionAnalysisPrompt(toolSchemasJson: string): string {
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

/** Substitutions for {@link toolSpecMockPrompt}. */
export interface ToolSpecMockPromptParams {
  environmentData?: string;
  tracing?: string;
  toolConnectionMapJson: string;
  stateStoreJson: string;
  toolName: string;
  toolDescription: string;
  toolSchemaJson: string;
  toolArgumentsJson: string;
}

/**
 * Builds the prompt asking a model to invent a realistic JSON response for
 * one tool call, consistent with the simulation state it is given.
 */
export function toolSpecMockPrompt({
  environmentData,
  tracing,
  toolConnectionMapJson,
  stateStoreJson,
  toolName,
  toolDescription,
  toolSchemaJson,
  toolArgumentsJson,
}: ToolSpecMockPromptParams): string {
  return `
  You are a stateful tool simulator. Your task is to generate a
  realistic JSON response for a tool call, maintaining consistency based
  on a shared state.

  ${environmentDataSnippet(environmentData)}

  ${tracingSnippet(tracing)}

  Here is the map of how tools connect via stateful parameters:
  ${toolConnectionMapJson}

  Here is the current state of all stateful parameters:
  ${stateStoreJson}

  You are now simulating the following tool call:
  Tool Name: ${toolName}
  Tool Description: ${toolDescription}
  Tool Schema: ${toolSchemaJson}
  Tool Arguments: ${toolArgumentsJson}

  Your instructions:
  1.  Analyze the tool call. Is it a "creating" or "consuming" tool
      based on the connection map?
  2.  If it's a "consuming" tool, check the provided arguments against
      the state store. If an ID is provided that does not exist in the
      state, return a realistic error (e.g., a 404 Not Found error).
      Otherwise, use the data from the state, the provided environment data,
      and the tracing history to generate the response.
  3.  If it's a "creating" tool, generate a new, unique ID for the
      stateful parameter (e.g., a random string for a ticket_id). Include
      this new ID in your response. I will then update the state with it.
  4.  Leverage the provided environment data (if any) to make your response
      more realistic and consistent with the simulated environment.
  5.  Leverage the provided tracing history (if any) to make your response
      consistent with observed tool behavior patterns from prior runs.
  6.  Generate a convincing, valid JSON object that mocks the tool's
      response. The response must be only the JSON object, without any
      additional text or formatting.
  7.  The response must start with '{' and end with '}'.
  `;
}

function environmentDataSnippet(environmentData?: string): string {
  if (!environmentData) {
    return '';
  }
  return `
        Here is relevant environment data (e.g., database snippet, context information):
        <environment_data>
        ${environmentData}
        </environment_data>
        Use this information to generate more realistic responses.
      `;
}

function tracingSnippet(tracing?: string): string {
  if (!tracing) {
    return '';
  }
  return `
        Here is a tracing history from a prior agent run (e.g., recorded tool
        calls and responses):
        <tracing>
        ${tracing}
        </tracing>
        Use this history to make your mock responses consistent with observed
        tool behavior patterns.
      `;
}
