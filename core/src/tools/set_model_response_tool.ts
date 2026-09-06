/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema} from '@google/genai';

import {FunctionTool} from './function_tool.js';

/** The name the model calls to return its structured answer. */
export const SET_MODEL_RESPONSE_TOOL_NAME = 'set_model_response';

const SET_MODEL_RESPONSE_TOOL_DESCRIPTION =
  'Call this tool to submit your final response conforming to the output schema. Use this tool only when you have collected all the information and are ready to return the final answer.';

/**
 * Creates the tool an agent uses to return structured output on a model that
 * cannot accept an output schema and tools in the same request.
 *
 * Its parameters are the agent's output schema, so the model fills the schema
 * in as a function call. The call's arguments become the agent's final answer,
 * and the tool sets `skipSummarization` so no further model turn rewrites them.
 *
 * @param outputSchema - The agent's output schema, used as the parameters.
 * @return The tool, ready to append to a request.
 */
export function createSetModelResponseTool(
  outputSchema: Schema,
): FunctionTool<Schema> {
  return new FunctionTool({
    name: SET_MODEL_RESPONSE_TOOL_NAME,
    description: SET_MODEL_RESPONSE_TOOL_DESCRIPTION,
    parameters: outputSchema,
    execute: async (args, toolContext) => {
      if (toolContext) {
        toolContext.actions.skipSummarization = true;
      }
      return JSON.stringify(args);
    },
  });
}
