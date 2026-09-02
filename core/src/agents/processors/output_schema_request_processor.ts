/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../../events/event.js';
import {
  appendInstructions,
  appendTools,
  LlmRequest,
} from '../../models/llm_request.js';
import {createSetModelResponseTool} from '../../tools/set_model_response_tool.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * The instruction that redirects the model's final answer into the
 * `set_model_response` call. The model is prompted against this exact wording,
 * which the Python implementation also uses, so treat it as part of the
 * contract.
 */
export const SET_MODEL_RESPONSE_INSTRUCTION =
  'IMPORTANT: You have access to other tools, but you must provide your ' +
  'final response using the set_model_response tool with the required ' +
  'structured format. After using any other tools needed to complete the ' +
  'task, always call set_model_response with your final answer in the ' +
  'specified schema format.';

/**
 * Declares the `set_model_response` tool and instructs the model to call it.
 *
 * An agent that wants structured output normally gets it from the model's
 * native response schema, which the basic request processor sets. A model that
 * cannot accept a response schema and tools in the same request needs the
 * prompt-based workaround instead: the schema becomes a tool, and the tool call
 * carries the answer.
 *
 * `LlmAgent.postprocess` reads the call back off the merged event and rewrites
 * it into the final content. The live path has no such read-back, so this
 * processor skips it rather than asking the model for an answer that nothing
 * would collect.
 *
 * A task-mode agent already returns its structured result through
 * `finish_task`, so this processor leaves it alone.
 */
export class OutputSchemaRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Declares the tool and appends the instruction, or leaves the request
   * untouched when the workaround does not apply.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request to declare the tool on.
   */
  // eslint-disable-next-line require-yield -- BaseLlmRequestProcessor mandates an AsyncGenerator; this processor only mutates the request.
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (
      invocationContext.liveRequestQueue ||
      !isLlmAgent(agent) ||
      !agent.outputSchema ||
      !agent.tools?.length ||
      agent.canonicalModel.capabilities.outputSchemaAndTools ||
      agent.mode === 'task'
    ) {
      return;
    }

    appendTools(llmRequest, [createSetModelResponseTool(agent.outputSchema)]);
    appendInstructions(llmRequest, [SET_MODEL_RESPONSE_INSTRUCTION]);
  }
}

/** The shared output schema request processor. */
export const OUTPUT_SCHEMA_REQUEST_PROCESSOR =
  new OutputSchemaRequestProcessor();
