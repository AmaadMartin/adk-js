/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema} from '@google/genai';
import {Event} from '../../events/event.js';
import {
  appendInstructions,
  appendTools,
  LlmRequest,
} from '../../models/llm_request.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {canUseOutputSchemaWithTools} from '../../utils/output_schema_utils.js';
import {Context} from '../context.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * The instruction that tells the model to return its final answer through the
 * `set_model_response` tool instead of as free text.
 */
export const SET_MODEL_RESPONSE_INSTRUCTION =
  'To output the final result, you must call the "set_model_response" function with the appropriate values. Do not output anything else.';

const SET_MODEL_RESPONSE_TOOL_NAME = 'set_model_response';

/**
 * Returns the structured answer the model passed as the call arguments. The
 * answer is already final, so the agent must not summarize it again.
 */
export async function submitModelResponse(
  args: unknown,
  toolContext?: Context,
): Promise<string> {
  if (toolContext) {
    toolContext.actions.skipSummarization = true;
  }
  return JSON.stringify(args);
}

/** Builds the tool through which the model returns its structured answer. */
export function createSetModelResponseTool(
  outputSchema: Schema,
): FunctionTool<Schema> {
  return new FunctionTool({
    name: SET_MODEL_RESPONSE_TOOL_NAME,
    description:
      'Call this tool to submit your final response conforming to the output schema. Use this tool only when you have collected all the information and are ready to return the final answer.',
    parameters: outputSchema,
    execute: submitModelResponse,
  });
}

/**
 * Declares the `set_model_response` tool and instructs the model to call it,
 * for an agent that wants structured output but whose model cannot accept an
 * output schema and tools in the same request.
 *
 * The model returns the structured answer as the arguments of that call, which
 * `LlmAgent` reads back off the merged event.
 */
export class OutputSchemaRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Registers the tool and appends the instruction, or leaves the request
   * untouched when the workaround does not apply.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request object to register the tool on.
   */
  // eslint-disable-next-line require-yield -- the base class mandates an AsyncGenerator; this processor only mutates the request.
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (
      !isLlmAgent(agent) ||
      !agent.outputSchema ||
      !agent.tools?.length ||
      canUseOutputSchemaWithTools(agent.canonicalModel.model) ||
      agent.mode === 'task'
    ) {
      return;
    }

    appendTools(llmRequest, [createSetModelResponseTool(agent.outputSchema)]);
    appendInstructions(llmRequest, [SET_MODEL_RESPONSE_INSTRUCTION]);
  }
}

export const OUTPUT_SCHEMA_REQUEST_PROCESSOR =
  new OutputSchemaRequestProcessor();
