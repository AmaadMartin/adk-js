/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, GenerateContentConfig} from '@google/genai';

import {BaseLlm} from '../../../models/base_llm.js';
import {LLMRegistry} from '../../../models/registry.js';
import {experimental} from '../../../utils/experimental.js';
import {
  generateJsonText,
  isJsonObject,
  parseFencedJson,
} from '../../../utils/llm_utils.js';

import {BaseMockStrategy, MockRequest} from './base.js';
import {updateStateStore} from './state_store.js';

/**
 * Builds the prompt asking a model to invent a realistic JSON response for one
 * tool call, consistent with the simulation state it is given.
 *
 * @param request The tool, its arguments, and the simulation state.
 * @param declaration The declaration of the tool being simulated.
 */
function buildToolSpecMockPrompt(
  request: MockRequest,
  declaration: FunctionDeclaration,
): string {
  const {tool, args, toolConnectionMap, stateStore, environmentData, tracing} =
    request;
  return `
  You are a stateful tool simulator. Your task is to generate a
  realistic JSON response for a tool call, maintaining consistency based
  on a shared state.

  ${
    environmentData
      ? `
        Here is relevant environment data (e.g., database snippet, context information):
        <environment_data>
        ${environmentData}
        </environment_data>
        Use this information to generate more realistic responses.
      `
      : ''
  }

  ${
    tracing
      ? `
        Here is a tracing history from a prior agent run (e.g., recorded tool
        calls and responses):
        <tracing>
        ${tracing}
        </tracing>
        Use this history to make your mock responses consistent with observed
        tool behavior patterns.
      `
      : ''
  }

  Here is the map of how tools connect via stateful parameters:
  ${toolConnectionMap ? JSON.stringify(toolConnectionMap, null, 2) : "''"}

  Here is the current state of all stateful parameters:
  ${JSON.stringify(stateStore, null, 2)}

  You are now simulating the following tool call:
  Tool Name: ${tool.name}
  Tool Description: ${tool.description}
  Tool Schema: ${JSON.stringify(declaration, null, 2)}
  Tool Arguments: ${JSON.stringify(args, null, 2)}

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
 * Simulates a tool call from the tool's own declaration, instead of running
 * the tool.
 *
 * A model is asked for a realistic JSON response to the call, given the tool's
 * schema, the call arguments, the stateful connections between the tools, and
 * the store of entities earlier calls invented. When the simulated tool
 * creates a stateful entity, its response is recorded in that store, so a
 * later call that consumes the entity is simulated consistently with it.
 */
@experimental
export class ToolSpecMockStrategy extends BaseMockStrategy {
  /**
   * Resolved on first use rather than in the constructor: adk-js checks a
   * Gemini model's credentials when it is constructed, and a strategy built
   * for a tool that is never called must not require them.
   */
  private llm?: BaseLlm;

  /**
   * @param llmName The model that generates the mock responses.
   * @param llmConfig The generation config for the mock call.
   */
  constructor(
    private readonly llmName: string,
    private readonly llmConfig: GenerateContentConfig,
  ) {
    super();
  }

  /**
   * Simulates one tool call.
   *
   * @param request The tool, its arguments, and the simulation state.
   * @returns The simulated response, or an error object when the tool has no
   *     declaration to simulate against, or the model does not answer with a
   *     JSON object.
   */
  async mock(request: MockRequest): Promise<Record<string, unknown>> {
    const {tool, toolConnectionMap, stateStore} = request;
    const declaration = tool._getDeclaration();
    if (!declaration) {
      return {
        status: 'error',
        errorMessage: 'Could not get tool declaration.',
      };
    }

    const responseText = await generateJsonText(
      (this.llm ??= LLMRegistry.newLlm(this.llmName)),
      this.llmConfig,
      buildToolSpecMockPrompt(request, declaration),
    );

    const parsed = parseFencedJson(responseText);
    if (parsed === undefined) {
      return {
        status: 'error',
        errorMessage: 'Failed to generate valid JSON mock response.',
        llmOutput: responseText,
      };
    }
    if (!isJsonObject(parsed)) {
      return {
        status: 'error',
        errorMessage: 'Generated mock response was not a JSON object.',
        llmOutput: responseText,
      };
    }

    updateStateStore(tool.name, parsed, stateStore, toolConnectionMap);
    return parsed;
  }
}
