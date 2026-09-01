/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig, HttpOptions} from '@google/genai';

import {Event} from '../../events/event.js';
import {LlmRequest, setOutputSchema} from '../../models/llm_request.js';
import {
  copyHttpOptions,
  copyRequestScopedConfig,
} from '../../utils/genai_config_utils.js';
import {isGemini3xLive} from '../../utils/model_name.js';
import {canUseOutputSchemaWithTools} from '../../utils/output_schema_utils.js';
import {InvocationContext} from '../invocation_context.js';
import {isLlmAgent} from '../llm_agent.js';
import {BaseLlmRequestProcessor} from './base_llm_processor.js';

/**
 * Merges the run config's HTTP options into the request config, run winning.
 *
 * `baseUrl` and `apiVersion` are configuration-time settings, not request-time,
 * so they are deliberately not merged into HTTP options the agent already set.
 */
function mergeRunConfigHttpOptions(
  config: GenerateContentConfig,
  runConfigHttpOptions: HttpOptions,
): void {
  if (!config.httpOptions) {
    config.httpOptions = copyHttpOptions(runConfigHttpOptions);
    return;
  }

  if (runConfigHttpOptions.headers) {
    config.httpOptions.headers = {
      ...config.httpOptions.headers,
      ...runConfigHttpOptions.headers,
    };
  }
  if (runConfigHttpOptions.timeout !== undefined) {
    config.httpOptions.timeout = runConfigHttpOptions.timeout;
  }
  if (runConfigHttpOptions.retryOptions !== undefined) {
    config.httpOptions.retryOptions = {...runConfigHttpOptions.retryOptions};
  }
  if (runConfigHttpOptions.extraBody !== undefined) {
    config.httpOptions.extraBody = {...runConfigHttpOptions.extraBody};
  }
}

/**
 * Copies the agent's sampling settings onto the live connect config.
 *
 * A live session reads `liveConnectConfig`, not `llmRequest.config`, so the
 * agent's sampling settings would not otherwise reach it. A field already set
 * on the live config outranks the agent's.
 */
function applyAgentSamplingToLiveConfig(
  liveConnectConfig: LlmRequest['liveConnectConfig'],
  agentConfig: GenerateContentConfig,
): void {
  liveConnectConfig.temperature ??= agentConfig.temperature;
  liveConnectConfig.topP ??= agentConfig.topP;
  liveConnectConfig.topK ??= agentConfig.topK;
  liveConnectConfig.maxOutputTokens ??= agentConfig.maxOutputTokens;
  liveConnectConfig.seed ??= agentConfig.seed;
  liveConnectConfig.mediaResolution ??= agentConfig.mediaResolution;
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

    // Preserved across the agent-config overwrite below, then merged back.
    const runConfigHttpOptions = llmRequest.config?.httpOptions;

    const agentConfig = agent.generateContentConfig ?? {};
    llmRequest.config = copyRequestScopedConfig(agentConfig);

    if (runConfigHttpOptions) {
      mergeRunConfigHttpOptions(llmRequest.config, runConfigHttpOptions);
    }

    if (invocationContext.runConfig?.labels) {
      llmRequest.config.labels = {
        ...llmRequest.config.labels,
        ...invocationContext.runConfig.labels,
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

    applyAgentSamplingToLiveConfig(llmRequest.liveConnectConfig, agentConfig);

    if (invocationContext.runConfig) {
      const runConfig = invocationContext.runConfig;
      const liveConnectConfig = llmRequest.liveConnectConfig;
      liveConnectConfig.responseModalities = runConfig.responseModalities;
      liveConnectConfig.speechConfig = runConfig.speechConfig;
      liveConnectConfig.outputAudioTranscription =
        runConfig.outputAudioTranscription;
      liveConnectConfig.inputAudioTranscription =
        runConfig.inputAudioTranscription;
      liveConnectConfig.realtimeInputConfig = runConfig.realtimeInputConfig;
      liveConnectConfig.explicitVadSignal = runConfig.explicitVadSignal;
      liveConnectConfig.translationConfig = runConfig.translationConfig;
      liveConnectConfig.contextWindowCompression =
        runConfig.contextWindowCompression;
      liveConnectConfig.avatarConfig = runConfig.avatarConfig;
      // Copied rather than aliased: `GoogleLlm.connect` deletes `transparent`
      // from this object in place, which would otherwise edit the caller's own
      // run config.
      liveConnectConfig.sessionResumption = runConfig.sessionResumption
        ? {...runConfig.sessionResumption}
        : undefined;

      // Gemini 3.x live models reject both fields.
      const gated = isGemini3xLive(llmRequest.model);
      liveConnectConfig.enableAffectiveDialog = gated
        ? undefined
        : runConfig.enableAffectiveDialog;
      liveConnectConfig.proactivity = gated ? undefined : runConfig.proactivity;
    }
  }
}

export const BASIC_LLM_REQUEST_PROCESSOR = new BasicLlmRequestProcessor();
