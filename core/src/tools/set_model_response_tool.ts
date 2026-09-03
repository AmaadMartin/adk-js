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

const VALIDATION_ERROR_ADVICE =
  'Recall the set_model_response function correctly, fix the errors, and call it again with all required fields using the correct types.';

/**
 * Creates the tool an agent uses to return structured output on a model that
 * cannot accept an output schema and tools in the same request.
 *
 * Its parameters are the agent's output schema, so the model fills the schema
 * in as a function call. The call's arguments become the agent's final answer
 * once `validateOutput` accepts them, and the tool records them on
 * `actions.setModelResponse` for the flow to promote.
 *
 * A schema violation is reported to the model as data rather than raised: the
 * tool answers the call with an `error` payload and leaves
 * `actions.setModelResponse` unset, so the model gets another turn to correct
 * itself.
 *
 * @param outputSchema - The agent's output schema, used as the parameters.
 * @param validateOutput - Returns the validated arguments, and throws when they
 *   do not satisfy the schema as the caller declared it, which may hold
 *   constraints the genai form cannot.
 * @return The tool, ready to append to a request.
 */
export function createSetModelResponseTool(
  outputSchema: Schema,
  validateOutput: (value: unknown) => unknown,
): FunctionTool<Schema> {
  return new FunctionTool({
    name: SET_MODEL_RESPONSE_TOOL_NAME,
    description: SET_MODEL_RESPONSE_TOOL_DESCRIPTION,
    parameters: outputSchema,
    execute: async (args, toolContext) => {
      if (!toolContext) {
        throw new Error(
          `Tool '${SET_MODEL_RESPONSE_TOOL_NAME}' requires a tool context.`,
        );
      }
      let result: unknown;
      try {
        result = validateOutput(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          error: `Validation Error found:\n${message}\n${VALIDATION_ERROR_ADVICE}`,
        };
      }
      toolContext.actions.setModelResponse = result;
      return result;
    },
  });
}
