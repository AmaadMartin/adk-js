/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {Context} from '../../agents/context.js';
import {BaseLlm} from '../../models/base_llm.js';
import {LLMRegistry} from '../../models/registry.js';
import {isRecord} from '../../utils/object_utils.js';
import {BaseTool} from '../base_tool.js';

import {
  JSON_INDENT,
  parseJsonFromModelText,
  requestJsonFromModel,
} from './model_json_request.js';
import {
  formatToolConnectionMap,
  StatefulParameter,
  ToolConnectionMap,
} from './tool_connection_map.js';

/**
 * The entities a creating tool has minted so far.
 *
 * The outer key is a stateful parameter name, the inner key is the value the
 * model minted for it, and the value is the mock response that carried it.
 */
export type StateStore = Record<
  string,
  Record<string, Record<string, unknown>>
>;

/** One tool call to mock. */
export interface MockRequest {
  /** The tool the agent called. */
  tool: BaseTool;
  /** The arguments the agent called it with. */
  args: Record<string, unknown>;
  /** The context of the call. */
  toolContext: Context;
  /** How the tools connect, when the analysis produced a map. */
  toolConnectionMap?: ToolConnectionMap;
  /** The entities minted so far. A creating tool adds to it. */
  stateStore: StateStore;
  /** Environment data, such as a small database dump, as JSON. */
  environmentData?: string;
  /** A prior agent run trace, as JSON. */
  tracing?: string;
}

function buildMockPrompt(params: {
  environmentDataSnippet: string;
  tracingSnippet: string;
  toolConnectionMapJson: string;
  stateStoreJson: string;
  toolName: string;
  toolDescription: string;
  toolSchemaJson: string;
  toolArgumentsJson: string;
}): string {
  return `
  You are a stateful tool simulator. Your task is to generate a
  realistic JSON response for a tool call, maintaining consistency based
  on a shared state.

  ${params.environmentDataSnippet}

  ${params.tracingSnippet}

  Here is the map of how tools connect via stateful parameters:
  ${params.toolConnectionMapJson}

  Here is the current state of all stateful parameters:
  ${params.stateStoreJson}

  You are now simulating the following tool call:
  Tool Name: ${params.toolName}
  Tool Description: ${params.toolDescription}
  Tool Schema: ${params.toolSchemaJson}
  Tool Arguments: ${params.toolArgumentsJson}

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

function buildEnvironmentDataSnippet(environmentData?: string): string {
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

function buildTracingSnippet(tracing?: string): string {
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

function findInValues(values: unknown[], targetKey: string): unknown {
  for (const value of values) {
    const found = findValueByKey(value, targetKey);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Searches a nested structure for the first non-null value under a key.
 *
 * @param data The structure to search.
 * @param targetKey The key to look for.
 * @return The value found, or `undefined`.
 */
function findValueByKey(data: unknown, targetKey: string): unknown {
  if (isRecord(data)) {
    const value = data[targetKey];
    if (value !== undefined && value !== null) {
      return value;
    }
    return findInValues(Object.values(data), targetKey);
  }
  if (Array.isArray(data)) {
    return findInValues(data, targetKey);
  }
  return undefined;
}

function recordMintedEntities(params: {
  toolName: string;
  statefulParameters: StatefulParameter[];
  mockResponse: Record<string, unknown>;
  stateStore: StateStore;
}): void {
  for (const parameter of params.statefulParameters) {
    if (!parameter.creatingTools.includes(params.toolName)) {
      continue;
    }
    const value = findValueByKey(params.mockResponse, parameter.parameterName);
    if (value === undefined) {
      continue;
    }
    const entities = (params.stateStore[parameter.parameterName] ??= {});
    entities[String(value)] = params.mockResponse;
  }
}

/**
 * Asks a model to mock a tool response from the tool's own declaration.
 *
 * The prompt carries the connection map and the state store, so an identifier
 * minted by a creating tool is honoured by a consuming tool later in the same
 * run.
 */
export class ToolSpecMockStrategy {
  private readonly llm: BaseLlm;
  private readonly llmConfig: GenerateContentConfig;

  /**
   * @param llmName The model that generates the mock responses.
   * @param llmConfig The configuration of those calls.
   */
  constructor(llmName: string, llmConfig: GenerateContentConfig) {
    this.llm = LLMRegistry.newLlm(llmName);
    this.llmConfig = llmConfig;
  }

  /**
   * Mocks one tool call, and records any entity the call minted.
   *
   * @param request The call to mock.
   * @return The mocked response, or an error response when the tool has no
   *     declaration to mock against or the model did not answer with a JSON
   *     object.
   */
  async mock(request: MockRequest): Promise<Record<string, unknown>> {
    const declaration = request.tool._getDeclaration();
    if (!declaration) {
      return {
        status: 'error',
        error_message: 'Could not get tool declaration.',
      };
    }

    const prompt = buildMockPrompt({
      environmentDataSnippet: buildEnvironmentDataSnippet(
        request.environmentData,
      ),
      tracingSnippet: buildTracingSnippet(request.tracing),
      toolConnectionMapJson: request.toolConnectionMap
        ? formatToolConnectionMap(request.toolConnectionMap)
        : "''",
      stateStoreJson: JSON.stringify(request.stateStore, null, JSON_INDENT),
      toolName: request.tool.name,
      toolDescription: request.tool.description,
      toolSchemaJson: JSON.stringify(declaration, null, JSON_INDENT),
      toolArgumentsJson: JSON.stringify(request.args, null, JSON_INDENT),
    });

    const responseText = await requestJsonFromModel(
      this.llm,
      prompt,
      this.llmConfig,
    );
    const parsed = parseJsonFromModelText(responseText);
    if (parsed === undefined) {
      return {
        status: 'error',
        error_message: 'Failed to generate valid JSON mock response.',
        llm_output: responseText,
      };
    }
    if (!isRecord(parsed)) {
      return {
        status: 'error',
        error_message: 'Generated mock response was not a JSON object.',
        llm_output: responseText,
      };
    }

    if (request.toolConnectionMap) {
      recordMintedEntities({
        toolName: request.tool.name,
        statefulParameters: request.toolConnectionMap.statefulParameters,
        mockResponse: parsed,
        stateStore: request.stateStore,
      });
    }
    return parsed;
  }
}
