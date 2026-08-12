/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HttpOptions} from '@google/genai';
import {Event} from '../../events/event.js';
import {LlmRequest, setOutputSchema} from '../../models/llm_request.js';
import {canUseOutputSchemaWithTools} from '../../utils/output_schema_utils.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Populates the {@link LlmRequest} with model configuration derived from the
 * agent, including the model name, generation config, output schema, and live
 * connect settings.
 */
export class BasicLlmRequestProcessor extends BaseLlmRequestProcessor {
  /**
   * Populates model name, generation config, output schema, and live connect
   * settings on the request from the agent and run config.
   *
   * @param invocationContext - The current invocation context.
   * @param llmRequest - The request object to populate in place.
   */
  // eslint-disable-next-line require-yield
  override async *runAsync(
    invocationContext: InvocationContext,
    llmRequest: LlmRequest,
  ): AsyncGenerator<Event, void, void> {
    const agent = invocationContext.agent;
    if (!isLlmAgent(agent)) {
      return;
    }

    // set model string, not model instance.
    llmRequest.model = agent.canonicalModel.model;

    llmRequest.config = {...(agent.generateContentConfig ?? {})};

    const runConfig = invocationContext.runConfig;
    if (runConfig?.httpOptions) {
      llmRequest.config.httpOptions = mergeHttpOptions(
        llmRequest.config.httpOptions,
        runConfig.httpOptions,
      );
    }
    if (runConfig?.labels) {
      llmRequest.config.labels = {
        ...llmRequest.config.labels,
        ...runConfig.labels,
      };
    }

    // Models that cannot take an output schema alongside tools get the
    // prompt-based `set_model_response` workaround instead, injected by
    // `LlmAgent.runOneStepAsync` and the instructions processor.
    // Task-mode agents complete via the `finish_task` tool, so the JSON response
    // mode must not be set (function calling is incompatible with a JSON
    // response mime type).
    if (
      agent.outputSchema &&
      agent.mode !== 'task' &&
      (!agent.tools?.length ||
        canUseOutputSchemaWithTools(agent.canonicalModel.model))
    ) {
      setOutputSchema(llmRequest, agent.outputSchema);
    }

    if (invocationContext.runConfig) {
      llmRequest.liveConnectConfig.responseModalities =
        invocationContext.runConfig.responseModalities;
      llmRequest.liveConnectConfig.speechConfig =
        invocationContext.runConfig.speechConfig;
      llmRequest.liveConnectConfig.outputAudioTranscription =
        invocationContext.runConfig.outputAudioTranscription;
      llmRequest.liveConnectConfig.inputAudioTranscription =
        invocationContext.runConfig.inputAudioTranscription;
      llmRequest.liveConnectConfig.realtimeInputConfig =
        invocationContext.runConfig.realtimeInputConfig;
      llmRequest.liveConnectConfig.enableAffectiveDialog =
        invocationContext.runConfig.enableAffectiveDialog;
      llmRequest.liveConnectConfig.proactivity =
        invocationContext.runConfig.proactivity;
    }
  }
}

/**
 * Merges the run config's HTTP options over the agent's, run config winning.
 *
 * Returns a new object, and a new `headers` object, so that later request
 * assembly cannot write through into the agent's shared
 * `generateContentConfig` or into the caller's run config. The Gemini model
 * appends tracking headers to `config.httpOptions.headers`.
 *
 * `baseUrl` and `apiVersion` are configuration-time settings rather than
 * request-time ones, so they do not override options the agent already set.
 */
function mergeHttpOptions(
  agentHttpOptions: HttpOptions | undefined,
  runConfigHttpOptions: HttpOptions,
): HttpOptions {
  if (!agentHttpOptions) {
    return {
      ...runConfigHttpOptions,
      ...(runConfigHttpOptions.headers && {
        headers: {...runConfigHttpOptions.headers},
      }),
    };
  }
  return {
    ...agentHttpOptions,
    ...(runConfigHttpOptions.timeout !== undefined && {
      timeout: runConfigHttpOptions.timeout,
    }),
    ...(runConfigHttpOptions.retryOptions !== undefined && {
      retryOptions: runConfigHttpOptions.retryOptions,
    }),
    ...(runConfigHttpOptions.extraBody !== undefined && {
      extraBody: runConfigHttpOptions.extraBody,
    }),
    ...(runConfigHttpOptions.headers && {
      headers: {...agentHttpOptions.headers, ...runConfigHttpOptions.headers},
    }),
  };
}

export const BASIC_LLM_REQUEST_PROCESSOR = new BasicLlmRequestProcessor();
