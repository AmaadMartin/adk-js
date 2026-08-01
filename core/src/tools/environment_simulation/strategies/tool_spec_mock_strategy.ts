/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {BaseLlm} from '../../../models/base_llm.js';
import {LLMRegistry} from '../../../models/registry.js';
import {experimental} from '../../../utils/experimental.js';
import {
  generateSimulationText,
  parseFencedJson,
} from '../simulation_llm_utils.js';
import {ToolConnectionMap} from '../tool_connection_map.js';

import {BaseMockStrategy, MockRequest} from './base.js';

interface ToolSpecMockPromptParams {
  environmentDataSnippet: string;
  tracingSnippet: string;
  toolConnectionMapJson: string;
  stateStoreJson: string;
  toolName: string;
  toolDescription: string;
  toolSchemaJson: string;
  toolArgumentsJson: string;
}

function toolSpecMockPrompt({
  environmentDataSnippet,
  tracingSnippet,
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

  ${environmentDataSnippet}

  ${tracingSnippet}

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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Defines an own data property on `target`.
 *
 * Both the parameter names and the entity ids used as keys here come from
 * model output. A plain `target[key] = value` would, for the key `__proto__`,
 * invoke the setter inherited from `Object.prototype` and mutate the prototype
 * chain instead of storing anything, so the property is defined explicitly.
 */
function setOwnProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Depth-first search for `targetKey` in a parsed JSON value. An own key on the
 * current object wins; otherwise the search descends into values and array
 * elements. A nullish hit does not stop the surrounding search.
 *
 * Only own keys count, matching Python's `target_key in data` on a dict.
 * Testing with `in` would instead walk the prototype chain, so a model-chosen
 * `__proto__` or `constructor` would "find" an inherited built-in in every
 * object it visited.
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
  if (isJsonObject(data)) {
    if (Object.hasOwn(data, targetKey)) {
      return data[targetKey];
    }
    for (const value of Object.values(data)) {
      const result = findValueByKey(value, targetKey);
      if (result !== undefined && result !== null) {
        return result;
      }
    }
  }
  return undefined;
}

/**
 * Records `mockResponse` against every stateful parameter `toolName` creates,
 * so a later consuming call can be simulated consistently with it.
 */
function updateStateStore(params: {
  toolName: string;
  mockResponse: Record<string, unknown>;
  stateStore: Record<string, Record<string, unknown>>;
  toolConnectionMap?: ToolConnectionMap;
}): void {
  const {toolName, mockResponse, stateStore, toolConnectionMap} = params;
  for (const parameter of toolConnectionMap?.statefulParameters ?? []) {
    if (!parameter.creatingTools.includes(toolName)) {
      continue;
    }
    const {parameterName} = parameter;
    const value = findValueByKey(mockResponse, parameterName);
    if (value === undefined || value === null) {
      continue;
    }
    if (!Object.hasOwn(stateStore, parameterName)) {
      setOwnProperty(stateStore, parameterName, {});
    }
    setOwnProperty(stateStore[parameterName], String(value), mockResponse);
  }
}

/** Mocks a tool response from the tool's own declaration. */
@experimental
export class ToolSpecMockStrategy extends BaseMockStrategy {
  /**
   * Resolved on first use rather than in the constructor: adk-js resolves a
   * Gemini model eagerly against its credentials, and a strategy built for a
   * tool that is never called must not require them.
   */
  private llm?: BaseLlm;

  /**
   * @param llmName The model used to generate mock responses.
   * @param llmConfig The generation config for the mock call.
   */
  constructor(
    private readonly llmName: string,
    private readonly llmConfig: GenerateContentConfig,
  ) {
    super();
  }

  async mock(request: MockRequest): Promise<Record<string, unknown>> {
    const {tool, args, toolConnectionMap, stateStore} = request;
    const declaration = tool._getDeclaration();
    if (!declaration) {
      return {
        status: 'error',
        error_message: 'Could not get tool declaration.',
      };
    }

    const prompt = toolSpecMockPrompt({
      environmentDataSnippet: environmentDataSnippet(request.environmentData),
      tracingSnippet: tracingSnippet(request.tracing),
      toolConnectionMapJson: toolConnectionMap
        ? JSON.stringify(toolConnectionMap, null, 2)
        : "''",
      stateStoreJson: JSON.stringify(stateStore, null, 2),
      toolName: tool.name,
      toolDescription: tool.description,
      toolSchemaJson: JSON.stringify(declaration, null, 2),
      toolArgumentsJson: JSON.stringify(args, null, 2),
    });

    const responseText = await generateSimulationText({
      llm: (this.llm ??= LLMRegistry.newLlm(this.llmName)),
      model: this.llmName,
      config: this.llmConfig,
      prompt,
    });

    const mockResponse = parseFencedJson(responseText);
    if (!isJsonObject(mockResponse)) {
      return {
        status: 'error',
        error_message: 'Failed to generate valid JSON mock response.',
        llm_output: responseText,
      };
    }

    updateStateStore({
      toolName: tool.name,
      mockResponse,
      stateStore,
      toolConnectionMap,
    });
    return mockResponse;
  }
}
