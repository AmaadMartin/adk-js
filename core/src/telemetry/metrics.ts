/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content} from '@google/genai';
import type {
  Attributes,
  Histogram,
  MeterProvider,
  MetricAdvice,
} from '@opentelemetry/api';
import {metrics} from '@opentelemetry/api';

import type {LlmRequest} from '../models/llm_request.js';
import type {LlmResponse} from '../models/llm_response.js';
import {contentSize} from '../utils/content_size_utils.js';
import {resolveErrorType} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {getGoogleLlmVariant, GoogleLLMVariant} from '../utils/variant_utils.js';
import {version} from '../version.js';
import {
  ERROR_TYPE,
  GEN_AI_AGENT_NAME,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_TOKEN_TYPE,
  GEN_AI_TOOL_NAME,
  GEN_AI_TOOL_TYPE,
} from './semconv.js';
import {inputTokenCount, outputTokenCount} from './token_usage.js';

const METER_NAME = 'gcp.vertex.agent';

interface HistogramSpec {
  name: string;
  unit: string;
  description: string;
  advice?: MetricAdvice;
}

/**
 * Name, unit, description and bucket advisory of every histogram recorded by
 * this module.
 *
 * The names, units and bucket boundaries are a wire contract shared with
 * adk-python, so a dashboard built against one runtime works against the
 * other. Do not rename or re-unit them.
 */
const HISTOGRAMS = {
  agentInvocationDuration: {
    name: 'gen_ai.invoke_agent.duration',
    unit: 's',
    description: 'Duration of agent invocations.',
    advice: {
      explicitBucketBoundaries: [
        0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8,
        409.6,
      ],
    },
  },
  toolExecutionDuration: {
    name: 'gen_ai.execute_tool.duration',
    unit: 's',
    description: 'Duration of tool executions.',
    advice: {
      explicitBucketBoundaries: [
        0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24,
        20.48, 40.96, 81.92,
      ],
    },
  },
  clientOperationDuration: {
    name: 'gen_ai.client.operation.duration',
    unit: 's',
    description: 'GenAI operation duration.',
  },
  clientTokenUsage: {
    name: 'gen_ai.client.token.usage',
    unit: '{token}',
    description: 'Number of input and output tokens used.',
  },
  agentRequestSize: {
    name: 'gen_ai.agent.request.size',
    unit: 'By',
    description: 'Size of agent requests.',
  },
  agentResponseSize: {
    name: 'gen_ai.agent.response.size',
    unit: 'By',
    description: 'Size of agent responses.',
  },
  agentWorkflowSteps: {
    name: 'gen_ai.agent.workflow.steps',
    unit: '1',
    description: 'Length of agentic workflow (# of events).',
  },
} satisfies Record<string, HistogramSpec>;

type HistogramKey = keyof typeof HISTOGRAMS;

let cache:
  | {provider: MeterProvider; instruments: Map<HistogramKey, Histogram>}
  | undefined;

/**
 * Returns the histogram for `key`, creating it on first use so that no
 * instrument is registered until a metric is actually recorded.
 *
 * Unlike the tracing API, the metrics API has no proxy that re-binds to a
 * meter provider installed later: `metrics.getMeterProvider()` resolves to
 * whatever is registered at call time, and the no-op provider before that.
 * Caching against the provider identity is what lets a provider registered
 * after the first recording still receive measurements.
 */
function histogram(key: HistogramKey): Histogram {
  const provider = metrics.getMeterProvider();
  if (cache?.provider !== provider) {
    cache = {provider, instruments: new Map()};
  }
  let instrument = cache.instruments.get(key);
  if (!instrument) {
    const spec: HistogramSpec = HISTOGRAMS[key];
    const {name, unit, description, advice} = spec;
    instrument = provider
      .getMeter(METER_NAME, version)
      .createHistogram(name, {unit, description, advice});
    cache.instruments.set(key, instrument);
  }
  return instrument;
}

/**
 * Runs a recording, never letting a telemetry failure reach the caller.
 *
 * @param what Named in the debug log so a swallowed failure is traceable.
 */
function safeRecord(what: string, record: () => void): void {
  try {
    record();
  } catch (e) {
    logger.debug(`Failed to record ${what}`, e);
  }
}

function getProviderName(): string {
  return getGoogleLlmVariant() === GoogleLLMVariant.VERTEX_AI
    ? 'vertex_ai'
    : 'gemini';
}

/**
 * Attributes shared by both `gen_ai.client.*` instruments.
 *
 * @param responseModel The model that answered, when it is known. The duration
 *     recorder leaves it out until a response has arrived.
 */
function clientAttributes(
  agentName: string,
  llmRequest: LlmRequest,
  responseModel?: string,
): Attributes {
  const attributes: Attributes = {
    [GEN_AI_AGENT_NAME]: agentName,
    [GEN_AI_OPERATION_NAME]: 'generate_content',
    [GEN_AI_PROVIDER_NAME]: getProviderName(),
  };
  if (llmRequest.model) {
    attributes[GEN_AI_REQUEST_MODEL] = llmRequest.model;
  }
  if (responseModel) {
    attributes[GEN_AI_RESPONSE_MODEL] = responseModel;
  }
  return attributes;
}

/** Records the duration of an agent invocation, in seconds. */
export function recordAgentInvocationDuration(
  agentName: string,
  elapsedS: number,
  error?: unknown,
): void {
  safeRecord('agent invocation duration', () => {
    const attributes: Attributes = {[GEN_AI_AGENT_NAME]: agentName};
    if (error !== undefined) {
      attributes[ERROR_TYPE] = resolveErrorType(error);
    }
    histogram('agentInvocationDuration').record(elapsedS, attributes);
  });
}

/**
 * Records the size of an agent's request.
 *
 * @param userContent The content the invocation was started with, if any.
 */
export function recordAgentRequestSize(
  agentName: string,
  userContent?: Content,
): void {
  safeRecord('agent request size', () => {
    histogram('agentRequestSize').record(contentSize(userContent), {
      [GEN_AI_AGENT_NAME]: agentName,
    });
  });
}

/**
 * Records the size of an agent's response.
 *
 * @param responseContent The content of the last event the agent authored
 *     during the invocation, if any.
 */
export function recordAgentResponseSize(
  agentName: string,
  responseContent?: Content,
): void {
  safeRecord('agent response size', () => {
    histogram('agentResponseSize').record(contentSize(responseContent), {
      [GEN_AI_AGENT_NAME]: agentName,
    });
  });
}

/**
 * Records the length of an agentic workflow.
 *
 * @param stepCount The number of events the agent authored during the
 *     invocation.
 */
export function recordAgentWorkflowSteps(
  agentName: string,
  stepCount: number,
): void {
  safeRecord('agent workflow steps', () => {
    histogram('agentWorkflowSteps').record(stepCount, {
      [GEN_AI_AGENT_NAME]: agentName,
    });
  });
}

/** Records the duration of a tool execution, in seconds. */
export function recordToolExecutionDuration(
  toolName: string,
  toolType: string,
  agentName: string,
  elapsedS: number,
  error?: unknown,
): void {
  safeRecord('tool execution duration', () => {
    const attributes: Attributes = {
      [GEN_AI_AGENT_NAME]: agentName,
      [GEN_AI_TOOL_NAME]: toolName,
      [GEN_AI_TOOL_TYPE]: toolType,
    };
    if (error !== undefined) {
      attributes[ERROR_TYPE] = resolveErrorType(error);
    }
    histogram('toolExecutionDuration').record(elapsedS, attributes);
  });
}

/**
 * Records the duration of a call to the model, in seconds.
 *
 * @param params.response The last response the call produced, if any. Only the
 *     last one carries the model version of the whole call.
 */
export function recordClientOperationDuration(params: {
  agentName: string;
  elapsedS: number;
  llmRequest: LlmRequest;
  response?: LlmResponse;
  error?: unknown;
}): void {
  safeRecord('client operation duration', () => {
    const {agentName, elapsedS, llmRequest, response, error} = params;
    const attributes = clientAttributes(
      agentName,
      llmRequest,
      response && (response.modelVersion || llmRequest.model),
    );
    if (error !== undefined) {
      attributes[ERROR_TYPE] = resolveErrorType(error);
    }
    histogram('clientOperationDuration').record(elapsedS, attributes);
  });
}

/**
 * Records the token usage of a call to the model, split into an `input` and an
 * `output` measurement.
 *
 * Cached content tokens are left out because they are already part of the
 * prompt tokens, and the total is left out because the semantic conventions
 * ask for the input/output breakdown instead.
 *
 * @param params.response The last response the call produced, if any. Usage in
 *     a streaming response is cumulative, so the last chunk holds the total
 *     for the whole request and earlier chunks must not be added to it.
 */
export function recordClientTokenUsage(params: {
  agentName: string;
  llmRequest: LlmRequest;
  response?: LlmResponse;
}): void {
  safeRecord('client token usage', () => {
    const {agentName, llmRequest, response} = params;
    if (!response) {
      return;
    }
    if (!response.usageMetadata) {
      logger.warn(
        `Skipping missing token usage metadata for agent ${agentName} and model ${llmRequest.model}`,
      );
      return;
    }

    const inputTokens = inputTokenCount(response.usageMetadata) ?? 0;
    const outputTokens = outputTokenCount(response.usageMetadata) ?? 0;
    const attributes = clientAttributes(
      agentName,
      llmRequest,
      response.modelVersion || llmRequest.model,
    );

    if (inputTokens > 0) {
      histogram('clientTokenUsage').record(inputTokens, {
        ...attributes,
        [GEN_AI_TOKEN_TYPE]: 'input',
      });
    }
    if (outputTokens > 0) {
      histogram('clientTokenUsage').record(outputTokens, {
        ...attributes,
        [GEN_AI_TOKEN_TYPE]: 'output',
      });
    }
  });
}
