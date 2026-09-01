/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, HttpOptions} from '@google/genai';

import {Event} from '../../events/event.js';
import {LlmRequest, setOutputSchema} from '../../models/llm_request.js';
import {canUseOutputSchemaWithTools} from '../../utils/output_schema_utils.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {LiveConnectConfigWithHistory} from '../run_config.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Copies HTTP options, including the `headers` object, so a later write into
 * the copy cannot reach the object it came from.
 */
function copyHttpOptions(httpOptions: HttpOptions): HttpOptions {
  return httpOptions.headers
    ? {...httpOptions, headers: {...httpOptions.headers}}
    : {...httpOptions};
}

/**
 * Merges the run config's HTTP options into the request config. The run config
 * wins on every key it sets.
 *
 * The options are copied in, so request assembly never writes back into the
 * caller's run config or into the agent's own `generateContentConfig`.
 * `baseUrl` and `apiVersion` configure the client rather than the request, so
 * they do not overwrite HTTP options the agent already set.
 */
function mergeRunConfigHttpOptions(
  config: GenerateContentConfig,
  runConfigHttpOptions: HttpOptions,
): void {
  if (!config.httpOptions) {
    config.httpOptions = copyHttpOptions(runConfigHttpOptions);
    return;
  }

  const merged = copyHttpOptions(config.httpOptions);
  if (runConfigHttpOptions.headers) {
    merged.headers = {...merged.headers, ...runConfigHttpOptions.headers};
  }
  if (runConfigHttpOptions.timeout !== undefined) {
    merged.timeout = runConfigHttpOptions.timeout;
  }
  if (runConfigHttpOptions.retryOptions !== undefined) {
    merged.retryOptions = runConfigHttpOptions.retryOptions;
  }
  if (runConfigHttpOptions.extraBody !== undefined) {
    merged.extraBody = runConfigHttpOptions.extraBody;
  }
  config.httpOptions = merged;
}

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
      mergeRunConfigHttpOptions(llmRequest.config, runConfig.httpOptions);
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

    if (runConfig) {
      const liveConnectConfig: LiveConnectConfigWithHistory =
        llmRequest.liveConnectConfig;
      liveConnectConfig.responseModalities = runConfig.responseModalities;
      liveConnectConfig.speechConfig = runConfig.speechConfig;
      liveConnectConfig.outputAudioTranscription =
        runConfig.outputAudioTranscription;
      liveConnectConfig.inputAudioTranscription =
        runConfig.inputAudioTranscription;
      liveConnectConfig.realtimeInputConfig = runConfig.realtimeInputConfig;
      liveConnectConfig.explicitVadSignal = runConfig.explicitVadSignal;
      liveConnectConfig.translationConfig = runConfig.translationConfig;
      liveConnectConfig.enableAffectiveDialog = runConfig.enableAffectiveDialog;
      liveConnectConfig.proactivity = runConfig.proactivity;
      liveConnectConfig.avatarConfig = runConfig.avatarConfig;
      // Copied rather than aliased: the live flow stamps each server-issued
      // resumption handle onto `sessionResumption`, and seeds `historyConfig`
      // when it replays history on a fresh connection. Aliasing the caller's
      // run config would carry those writes into a later run.
      liveConnectConfig.sessionResumption = runConfig.sessionResumption
        ? {...runConfig.sessionResumption}
        : undefined;
      liveConnectConfig.historyConfig = runConfig.historyConfig
        ? {...runConfig.historyConfig}
        : undefined;
    }
  }
}

export const BASIC_LLM_REQUEST_PROCESSOR = new BasicLlmRequestProcessor();
