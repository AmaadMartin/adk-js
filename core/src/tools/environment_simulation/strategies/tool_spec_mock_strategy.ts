/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {experimental} from '../../../utils/experimental.js';
import {generateSimulationText, stripJsonFence} from '../simulation_model.js';
import {ToolConnectionMap, toWireJson} from '../tool_connection_map.js';

import {
  BaseMockStrategy,
  MockStrategyParams,
  SimulationStateStore,
} from './base.js';

/** The answer when the tool declares no schema to mock against. */
const NO_DECLARATION_MESSAGE = 'Could not get tool declaration.';

/** The answer when the model's response is not JSON. */
const UNPARSEABLE_RESPONSE_MESSAGE =
  'Failed to generate valid JSON mock response.';

/** The answer when the model's response is JSON but not an object. */
const NOT_AN_OBJECT_MESSAGE = 'Generated mock response was not a JSON object.';

/** Stands in for an absent connection map, as adk-python does. */
const NO_CONNECTION_MAP_JSON = "''";

/** Reports whether `value` is a JSON object rather than an array or null. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Searches a parsed JSON value for `targetKey`, at any depth.
 *
 * A key present with a null value counts as absent at the level above it, so
 * the search carries on into the remaining siblings.
 *
 * @param data The value to search.
 * @param targetKey The key to look for.
 * @returns The first value found, or undefined.
 */
function findValueByKey(data: unknown, targetKey: string): unknown {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findValueByKey(item, targetKey);
      if (found !== undefined && found !== null) {
        return found;
      }
    }
    return undefined;
  }
  if (!isJsonObject(data)) {
    return undefined;
  }
  if (targetKey in data) {
    return data[targetKey];
  }
  for (const value of Object.values(data)) {
    const found = findValueByKey(value, targetKey);
    if (found !== undefined && found !== null) {
      return found;
    }
  }
  return undefined;
}

/**
 * Records the entities a creating tool just produced.
 *
 * @param params.toolName The tool that produced the response.
 * @param params.mockResponse The response the model generated.
 * @param params.connectionMap How the tools connect.
 * @param params.stateStore The store to add to. Mutated in place.
 */
function recordCreatedEntities(params: {
  toolName: string;
  mockResponse: Record<string, unknown>;
  connectionMap: ToolConnectionMap;
  stateStore: SimulationStateStore;
}): void {
  for (const parameter of params.connectionMap.statefulParameters) {
    if (!parameter.creatingTools.includes(params.toolName)) {
      continue;
    }
    const parameterValue = findValueByKey(
      params.mockResponse,
      parameter.parameterName,
    );
    if (parameterValue === undefined || parameterValue === null) {
      continue;
    }
    const entities = (params.stateStore[parameter.parameterName] ??= {});
    // The whole response becomes the entity, so a later modification of the
    // same id replaces what a creation left behind.
    entities[String(parameterValue)] = params.mockResponse;
  }
}

/**
 * Builds the prompt that asks the model to mock one tool call.
 *
 * The wording is adk-python's, including the snake_case keys the model reads.
 */
function buildToolSpecMockPrompt(params: {
  toolName: string;
  toolDescription: string;
  toolSchemaJson: string;
  toolArgumentsJson: string;
  toolConnectionMapJson: string;
  stateStoreJson: string;
  environmentData?: string;
  tracing?: string;
}): string {
  const environmentDataSnippet = params.environmentData
    ? `
        Here is relevant environment data (e.g., database snippet, context information):
        <environment_data>
        ${params.environmentData}
        </environment_data>
        Use this information to generate more realistic responses.
      `
    : '';

  const tracingSnippet = params.tracing
    ? `
        Here is a tracing history from a prior agent run (e.g., recorded tool
        calls and responses):
        <tracing>
        ${params.tracing}
        </tracing>
        Use this history to make your mock responses consistent with observed
        tool behavior patterns.
      `
    : '';

  return `
  You are a stateful tool simulator. Your task is to generate a
  realistic JSON response for a tool call, maintaining consistency based
  on a shared state.

  ${environmentDataSnippet}

  ${tracingSnippet}

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

/**
 * Asks a model to invent a tool response from the tool's own declaration.
 *
 * The prompt carries the connection map and the entities created so far, so a
 * tool that reads an id sees what the tool that created it returned.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
@experimental
export class ToolSpecMockStrategy extends BaseMockStrategy {
  private readonly model: string;
  private readonly modelConfig: GenerateContentConfig;

  /**
   * @param params.model The model to ask for the mocked response.
   * @param params.modelConfig The configuration of that model call.
   */
  constructor(params: {model: string; modelConfig: GenerateContentConfig}) {
    super();
    this.model = params.model;
    this.modelConfig = params.modelConfig;
  }

  /**
   * Mocks one tool call, and records what a creating tool produced.
   *
   * @param params The tool call to answer.
   * @returns The generated response, or an `{status, error_message}` object
   *     when the tool declares no schema or the model answers with something
   *     other than a JSON object.
   */
  async mock(params: MockStrategyParams): Promise<Record<string, unknown>> {
    const declaration = params.tool._getDeclaration();
    if (!declaration) {
      return {status: 'error', error_message: NO_DECLARATION_MESSAGE};
    }

    const prompt = buildToolSpecMockPrompt({
      toolName: params.tool.name,
      toolDescription: params.tool.description,
      toolSchemaJson: JSON.stringify(declaration, null, 2),
      toolArgumentsJson: JSON.stringify(params.args, null, 2),
      toolConnectionMapJson: params.toolConnectionMap
        ? toWireJson(params.toolConnectionMap)
        : NO_CONNECTION_MAP_JSON,
      stateStoreJson: JSON.stringify(params.stateStore, null, 2),
      environmentData: params.environmentData,
      tracing: params.tracing,
    });

    const responseText = await generateSimulationText({
      model: this.model,
      modelConfig: this.modelConfig,
      prompt,
    });

    let parsedResponse: unknown;
    try {
      parsedResponse = JSON.parse(stripJsonFence(responseText));
    } catch {
      return {
        status: 'error',
        error_message: UNPARSEABLE_RESPONSE_MESSAGE,
        llm_output: responseText,
      };
    }

    if (!isJsonObject(parsedResponse)) {
      return {
        status: 'error',
        error_message: NOT_AN_OBJECT_MESSAGE,
        llm_output: responseText,
      };
    }

    if (params.toolConnectionMap) {
      recordCreatedEntities({
        toolName: params.tool.name,
        mockResponse: parsedResponse,
        connectionMap: params.toolConnectionMap,
        stateStore: params.stateStore,
      });
    }
    return parsedResponse;
  }
}
