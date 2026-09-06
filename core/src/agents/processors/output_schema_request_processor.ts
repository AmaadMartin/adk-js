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
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * The tool name the model must call to deliver its structured final answer.
 */
export const SET_MODEL_RESPONSE_TOOL_NAME = 'set_model_response';

/**
 * The instruction that tells the model to route its final answer through
 * {@link SET_MODEL_RESPONSE_TOOL_NAME}. The model is prompted against this
 * exact wording, so treat it as part of the contract.
 */
export const OUTPUT_SCHEMA_INSTRUCTION =
  'IMPORTANT: You have access to other tools, but you must provide your ' +
  'final response using the set_model_response tool with the required ' +
  'structured format. After using any other tools needed to complete the ' +
  'task, always call set_model_response with your final answer in the ' +
  'specified schema format.';

/**
 * Builds the tool the model calls to submit its final structured answer.
 *
 * @param outputSchema - The schema the tool parameters mirror.
 * @return A tool that echoes its arguments back as JSON.
 */
function createSetModelResponseTool(
  outputSchema: Schema,
): FunctionTool<Schema> {
  return new FunctionTool({
    name: SET_MODEL_RESPONSE_TOOL_NAME,
    description:
      'Call this tool to submit your final response conforming to the output schema. Use this tool only when you have collected all the information and are ready to return the final answer.',
    parameters: outputSchema,
    execute: async (args, toolContext) => {
      if (toolContext) {
        toolContext.actions.skipSummarization = true;
      }
      return JSON.stringify(args);
    },
  });
}

/**
 * Lets an agent combine an output schema with tools on a model that cannot
 * accept both natively.
 *
 * A model that accepts an output schema alongside tools needs no help, so this
 * processor leaves the request alone. Otherwise it offers the model a
 * `set_model_response` tool whose parameters are the output schema, and one
 * instruction telling the model to answer through that tool.
 */
export class OutputSchemaRequestProcessor extends BaseLlmRequestProcessor {
  // eslint-disable-next-line require-yield -- BaseLlmRequestProcessor mandates an AsyncGenerator; this processor only mutates the request.
  async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (
      !isLlmAgent(agent) ||
      !agent.outputSchema ||
      !agent.tools?.length ||
      agent.mode === 'task' ||
      canUseOutputSchemaWithTools(agent.canonicalModel.model)
    ) {
      return;
    }

    appendTools(llmRequest, [createSetModelResponseTool(agent.outputSchema)]);
    appendInstructions(llmRequest, [OUTPUT_SCHEMA_INSTRUCTION]);
  }
}

/** The shared {@link OutputSchemaRequestProcessor} instance. */
export const OUTPUT_SCHEMA_REQUEST_PROCESSOR =
  new OutputSchemaRequestProcessor();
