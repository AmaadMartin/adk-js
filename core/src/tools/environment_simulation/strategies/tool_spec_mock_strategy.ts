/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, GenerateContentConfig} from '@google/genai';

import {BaseLlm} from '../../../models/base_llm.js';
import {LLMRegistry} from '../../../models/registry.js';
import {
  generateSimulationText,
  stripJsonCodeFence,
} from '../simulation_model.js';
import {
  ToolConnectionMap,
  toWireToolConnectionMap,
} from '../tool_connection_map.js';

import {BaseMockStrategy, MockRequest} from './base.js';

const TOOL_SPEC_MOCK_PROMPT_TEMPLATE = `
  You are a stateful tool simulator. Your task is to generate a
  realistic JSON response for a tool call, maintaining consistency based
  on a shared state.

  {environment_data_snippet}

  {tracing_snippet}

  Here is the map of how tools connect via stateful parameters:
  {tool_connection_map_json}

  Here is the current state of all stateful parameters:
  {state_store_json}

  You are now simulating the following tool call:
  Tool Name: {tool_name}
  Tool Description: {tool_description}
  Tool Schema: {tool_schema_json}
  Tool Arguments: {tool_arguments_json}

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

/** The two-character placeholder adk-python emits when there is no map. */
const NO_CONNECTION_MAP_JSON = "''";

/**
 * Finds the value of `targetKey` anywhere in `data`.
 *
 * A direct key hit on an object wins, then its values are searched in
 * insertion order, then the items of an array in order. A `null` value counts
 * as not found, because adk-python's sentinel is `None` and its caller cannot
 * tell that apart from an absent key.
 *
 * @param data The value to search.
 * @param targetKey The key to look for.
 * @returns The first value found, or `undefined`.
 */
function findValueByKey(data: unknown, targetKey: string): unknown {
  if (Array.isArray(data)) {
    for (const item of data) {
      const result = findValueByKey(item, targetKey);
      if (result !== undefined) {
        return result;
      }
    }
    return undefined;
  }
  if (!isJsonObject(data)) {
    return undefined;
  }
  if (targetKey in data && data[targetKey] !== null) {
    return data[targetKey];
  }
  for (const value of Object.values(data)) {
    const result = findValueByKey(value, targetKey);
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

/** Reports whether `value` is a JSON object rather than an array or null. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Renders the optional environment-data block of the prompt. */
function renderEnvironmentDataSnippet(environmentData: string): string {
  return `
        Here is relevant environment data (e.g., database snippet, context information):
        <environment_data>
        ${environmentData}
        </environment_data>
        Use this information to generate more realistic responses.
      `;
}

/** Renders the optional tracing block of the prompt. */
function renderTracingSnippet(tracing: string): string {
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

/**
 * Records the entities a creating tool produced in the shared state store.
 *
 * Only the parameters `toolName` creates are considered, and only when the
 * mock response carries a value for one. Existing entries are kept.
 */
function recordCreatedEntities(params: {
  toolName: string;
  toolConnectionMap: ToolConnectionMap;
  mockResponse: Record<string, unknown>;
  stateStore: Record<string, unknown>;
}): void {
  for (const parameter of params.toolConnectionMap.statefulParameters) {
    if (!parameter.creatingTools.includes(params.toolName)) {
      continue;
    }
    const value = findValueByKey(params.mockResponse, parameter.parameterName);
    if (value === undefined) {
      continue;
    }
    const existing = params.stateStore[parameter.parameterName];
    const entities = isJsonObject(existing) ? existing : {};
    entities[String(value)] = params.mockResponse;
    params.stateStore[parameter.parameterName] = entities;
  }
}

/**
 * Asks a model to invent a tool response from the tool's own declaration.
 *
 * The prompt carries the connection map and the state store, so a call that
 * reads an entity an earlier call created stays consistent with it.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export class ToolSpecMockStrategy extends BaseMockStrategy {
  private readonly llm: BaseLlm;

  /**
   * @param modelName The model that generates the mock responses.
   * @param modelConfig The configuration of those model calls.
   */
  constructor(
    private readonly modelName: string,
    private readonly modelConfig: GenerateContentConfig,
  ) {
    super();
    this.llm = LLMRegistry.newLlm(modelName);
  }

  override async mock(request: MockRequest): Promise<Record<string, unknown>> {
    const declaration = request.tool._getDeclaration();
    if (!declaration) {
      return {
        status: 'error',
        error_message: 'Could not get tool declaration.',
      };
    }

    const rawText = await generateSimulationText({
      llm: this.llm,
      modelName: this.modelName,
      modelConfig: this.modelConfig,
      prompt: buildPrompt(request, declaration),
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonCodeFence(rawText));
    } catch {
      return {
        status: 'error',
        error_message: 'Failed to generate valid JSON mock response.',
        llm_output: rawText,
      };
    }

    if (!isJsonObject(parsed)) {
      return {
        status: 'error',
        error_message: 'Generated mock response was not a JSON object.',
        llm_output: rawText,
      };
    }

    if (request.toolConnectionMap) {
      recordCreatedEntities({
        toolName: request.tool.name,
        toolConnectionMap: request.toolConnectionMap,
        mockResponse: parsed,
        stateStore: request.stateStore,
      });
    }
    return parsed;
  }
}

/**
 * Fills the prompt template for one tool call.
 *
 * Every replacement is a function, because a string replacement would expand
 * a `$&` or `$1` the model arguments happen to contain.
 */
function buildPrompt(
  request: MockRequest,
  declaration: FunctionDeclaration,
): string {
  const values: Record<string, string> = {
    '{environment_data_snippet}': request.environmentData
      ? renderEnvironmentDataSnippet(request.environmentData)
      : '',
    '{tracing_snippet}': request.tracing
      ? renderTracingSnippet(request.tracing)
      : '',
    '{tool_connection_map_json}': request.toolConnectionMap
      ? JSON.stringify(
          toWireToolConnectionMap(request.toolConnectionMap),
          null,
          2,
        )
      : NO_CONNECTION_MAP_JSON,
    '{state_store_json}': JSON.stringify(request.stateStore, null, 2),
    '{tool_name}': request.tool.name,
    '{tool_description}': request.tool.description,
    '{tool_schema_json}': JSON.stringify(declaration, null, 2),
    '{tool_arguments_json}': JSON.stringify(request.args, null, 2),
  };
  let prompt = TOOL_SPEC_MOCK_PROMPT_TEMPLATE;
  for (const [placeholder, value] of Object.entries(values)) {
    prompt = prompt.replace(placeholder, () => value);
  }
  return prompt;
}
