/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {experimental} from '../../../utils/experimental.js';
import {isJsonObject, parseFencedJson} from '../../../utils/json_utils.js';
import {SimulationModel} from '../simulation_model.js';
import {ToolConnectionMap} from '../tool_connection_map.js';
import {BaseMockStrategy, MockParams, SimulationStateStore} from './base.js';

const TOOL_SPEC_MOCK_PROMPT_TEMPLATE = `
  You are a stateful tool simulator. Your task is to generate a
  realistic JSON response for a tool call, maintaining consistency based
  on a shared state.

  {environmentDataSnippet}

  {tracingSnippet}

  Here is the map of how tools connect via stateful parameters:
  {toolConnectionMapJson}

  Here is the current state of all stateful parameters:
  {stateStoreJson}

  You are now simulating the following tool call:
  Tool Name: {toolName}
  Tool Description: {toolDescription}
  Tool Schema: {toolSchemaJson}
  Tool Arguments: {toolArgumentsJson}

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

/** Wraps the caller's environment data in its own section of the prompt. */
function environmentDataSnippet(environmentData: string): string {
  return `
        Here is relevant environment data (e.g., database snippet, context information):
        <environment_data>
        ${environmentData}
        </environment_data>
        Use this information to generate more realistic responses.
      `;
}

/** Wraps the caller's trace in its own section of the prompt. */
function tracingSnippet(tracing: string): string {
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
 * Fills the prompt template in for one tool call.
 *
 * Each value is substituted through a replacer function, because a `$` pattern
 * in a tool description or in the state store would otherwise be expanded by
 * `String.prototype.replace`.
 *
 * @param params The tool call to answer.
 * @param toolSchemaJson The tool's declaration, as JSON.
 * @returns The prompt to send to the model.
 */
function buildMockPrompt(params: MockParams, toolSchemaJson: string): string {
  const replacements: Array<[string, string]> = [
    [
      '{environmentDataSnippet}',
      params.environmentData
        ? environmentDataSnippet(params.environmentData)
        : '',
    ],
    ['{tracingSnippet}', params.tracing ? tracingSnippet(params.tracing) : ''],
    [
      '{toolConnectionMapJson}',
      params.toolConnectionMap
        ? JSON.stringify(params.toolConnectionMap, null, 2)
        : "''",
    ],
    ['{stateStoreJson}', JSON.stringify(params.stateStore, null, 2)],
    ['{toolName}', params.tool.name],
    ['{toolDescription}', params.tool.description],
    ['{toolSchemaJson}', toolSchemaJson],
    ['{toolArgumentsJson}', JSON.stringify(params.args, null, 2)],
  ];
  let prompt = TOOL_SPEC_MOCK_PROMPT_TEMPLATE;
  for (const [placeholder, value] of replacements) {
    prompt = prompt.replace(placeholder, () => value);
  }
  return prompt;
}

/**
 * Sets `key` on `record` as an own data property.
 *
 * Both the parameter names and the parameter values come from model output, so
 * a key can be `__proto__`, which plain assignment routes to the prototype
 * instead of creating a property. Python has no such key, so the reference
 * needs no equivalent.
 *
 * @param record The object to write into.
 * @param key The property name, which may be any string.
 * @param value The value to store.
 */
function setOwnProperty<T>(
  record: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Searches a nested value for the first entry stored under `targetKey`.
 *
 * An object is searched before its nested values, and an array is searched in
 * order. `null` counts as absent, matching adk-python, but `0`, `false` and the
 * empty string are values a tool can legitimately return and count as found.
 *
 * Only own properties count. `targetKey` comes from model output, so an
 * inherited name such as `constructor` would otherwise be "found" on every
 * object.
 *
 * @param data The value to search.
 * @param targetKey The key to look for.
 * @returns The first value found, or `undefined`.
 */
function findValueByKey(data: unknown, targetKey: string): unknown {
  if (Array.isArray(data)) {
    for (const item of data) {
      const result = findValueByKey(item, targetKey);
      if (result !== undefined && result !== null) {
        return result;
      }
    }
    return undefined;
  }
  if (!isJsonObject(data)) {
    return undefined;
  }
  if (Object.hasOwn(data, targetKey)) {
    return data[targetKey];
  }
  for (const value of Object.values(data)) {
    const result = findValueByKey(value, targetKey);
    if (result !== undefined && result !== null) {
      return result;
    }
  }
  return undefined;
}

/**
 * Records `mockResponse` under every stateful parameter that `toolName`
 * creates.
 *
 * @param params.toolName The tool that produced the response.
 * @param params.mockResponse The response the model generated.
 * @param params.toolConnectionMap How the simulated tools connect.
 * @param params.stateStore The store to write into. It is mutated in place,
 *     because the engine shares one store across every call of a simulation.
 */
function recordCreatedEntities(params: {
  toolName: string;
  mockResponse: Record<string, unknown>;
  toolConnectionMap: ToolConnectionMap;
  stateStore: SimulationStateStore;
}): void {
  const {toolName, mockResponse, toolConnectionMap, stateStore} = params;
  for (const parameter of toolConnectionMap.statefulParameters) {
    if (!parameter.creatingTools.includes(toolName)) {
      continue;
    }
    const value = findValueByKey(mockResponse, parameter.parameterName);
    if (value === undefined || value === null) {
      continue;
    }
    let entities = Object.hasOwn(stateStore, parameter.parameterName)
      ? stateStore[parameter.parameterName]
      : undefined;
    if (!entities) {
      entities = {};
      setOwnProperty(stateStore, parameter.parameterName, entities);
    }
    setOwnProperty(entities, String(value), mockResponse);
  }
}

/**
 * Asks a model to invent a tool's response from the tool's own declaration.
 *
 * The state store carries entities between calls, so an id a creating tool
 * invented is visible to the consuming tool that reads it back.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
@experimental
export class ToolSpecMockStrategy extends BaseMockStrategy {
  private readonly simulationModel: SimulationModel;

  /**
   * @param params.model The model to ask.
   * @param params.modelConfig The configuration of that model call.
   */
  constructor(params: {model: string; modelConfig: GenerateContentConfig}) {
    super();
    this.simulationModel = new SimulationModel(
      params.model,
      params.modelConfig,
    );
  }

  /**
   * Generates a mock response for one tool call.
   *
   * An answer the strategy cannot use becomes an error object the agent can
   * react to, the way a failing tool would. A failed model call is not
   * answered here: it propagates, as it does in adk-python.
   *
   * @param params The tool call to answer.
   * @returns The model's JSON object, or an error object naming what went
   *     wrong.
   * @throws {Error} When the model call itself fails.
   */
  async mock(params: MockParams): Promise<Record<string, unknown>> {
    const declaration = params.tool._getDeclaration();
    if (!declaration) {
      return {status: 'error', errorMessage: 'Could not get tool declaration.'};
    }

    const prompt = buildMockPrompt(
      params,
      JSON.stringify(declaration, null, 2),
    );
    const llmOutput = await this.simulationModel.generateText(prompt);
    const parsed = parseFencedJson(llmOutput);
    if (parsed === undefined) {
      return {
        status: 'error',
        errorMessage: 'Failed to generate valid JSON mock response.',
        llmOutput,
      };
    }
    if (!isJsonObject(parsed)) {
      return {
        status: 'error',
        errorMessage: 'Generated mock response was not a JSON object.',
        llmOutput,
      };
    }

    if (params.toolConnectionMap) {
      recordCreatedEntities({
        toolName: params.tool.name,
        mockResponse: parsed,
        toolConnectionMap: params.toolConnectionMap,
        stateStore: params.stateStore,
      });
    }
    return parsed;
  }
}
