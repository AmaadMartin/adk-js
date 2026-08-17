/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {
  Attributes,
  Histogram,
  MeterProvider,
  MetricAdvice,
  metrics,
} from '@opentelemetry/api';

import type {InvocationContext} from '../agents/invocation_context.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {contentSize} from '../utils/content_size_utils.js';
import {resolveErrorType} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {extractModelName, isGeminiModel} from '../utils/model_name.js';
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
  GEN_AI_WORKFLOW_NAME,
  GEN_AI_WORKFLOW_NESTED,
} from './semconv.js';
import {inputTokenCount, outputTokenCount} from './token_usage.js';

const METER_NAME = 'gcp.vertex.agent';

/**
 * Bucket boundaries shared by the two per-invocation call-count histograms.
 * They count whole calls, so the buckets are dense over the first handful and
 * then widen.
 */
const CALL_COUNT_BOUNDARIES = [0, 1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 64];

/**
 * Anthropic models reach ADK either as a bare `claude-*` id or, on Model
 * Garden, as a `claude.*` one.
 */
const ANTHROPIC_MODEL_PATTERN = /^claude[-.]/i;

/**
 * Leading segments of a resource-path model id, e.g. a Model Garden path like
 * `projects/<p>/locations/<l>/publishers/<pub>/models/<m>` or a tuned-model id
 * like `tunedModels/<id>`. They name a resource collection, never a provider,
 * so the provider-prefix rule must not read one as one.
 */
const RESOURCE_COLLECTION_SEGMENTS = new Set([
  'endpoints',
  'locations',
  'models',
  'projects',
  'publishers',
  'tunedmodels',
]);

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
  workflowInvocationDuration: {
    name: 'gen_ai.invoke_workflow.duration',
    unit: 's',
    description: 'Duration of workflow invocations.',
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
  invokeAgentInferenceCalls: {
    name: 'gen_ai.invoke_agent.inference_calls',
    unit: '1',
    description: 'Number of inference (model) calls per agent invocation.',
    advice: {explicitBucketBoundaries: CALL_COUNT_BOUNDARIES},
  },
  invokeAgentToolCalls: {
    name: 'gen_ai.invoke_agent.tool_calls',
    unit: '1',
    description: 'Number of tool calls per agent invocation.',
    advice: {explicitBucketBoundaries: CALL_COUNT_BOUNDARIES},
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

/** The provider name to report when the model id names no provider. */
function guessGeminiProvider(): string {
  return getGoogleLlmVariant() === GoogleLLMVariant.VERTEX_AI
    ? 'vertex_ai'
    : 'gemini';
}

/**
 * Returns the `gen_ai.provider.name` value for a model.
 *
 * The name has to follow the model actually being served, otherwise every
 * provider is reported as Gemini. A LiteLLM-style `<provider>/<model>` id
 * carries the provider in its prefix. The prefix is read off the bare model
 * name so that a resource path, whose leading segments describe where the
 * model lives rather than who serves it, is not mistaken for one.
 *
 * @param model The model id the request is being served by, if known.
 */
function resolveProviderName(model?: string): string {
  if (!model || isGeminiModel(model)) {
    return guessGeminiProvider();
  }
  const modelName = extractModelName(model);
  if (ANTHROPIC_MODEL_PATTERN.test(modelName)) {
    return 'anthropic';
  }
  const separatorIndex = modelName.indexOf('/');
  if (separatorIndex > 0) {
    const provider = modelName.slice(0, separatorIndex).toLowerCase();
    if (!RESOURCE_COLLECTION_SEGMENTS.has(provider)) {
      return provider;
    }
  }
  return guessGeminiProvider();
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
    [GEN_AI_PROVIDER_NAME]: resolveProviderName(llmRequest.model),
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

/** Records how many model calls one agent invocation made. */
export function recordInvokeAgentInferenceCalls(
  agentName: string,
  count: number,
): void {
  safeRecord('invoke agent inference calls', () => {
    histogram('invokeAgentInferenceCalls').record(count, {
      [GEN_AI_AGENT_NAME]: agentName,
    });
  });
}

/** Records how many tool calls one agent invocation made. */
export function recordInvokeAgentToolCalls(
  agentName: string,
  count: number,
): void {
  safeRecord('invoke agent tool calls', () => {
    histogram('invokeAgentToolCalls').record(count, {
      [GEN_AI_AGENT_NAME]: agentName,
    });
  });
}

/** The model and tool calls one agent invocation has made so far. */
interface InvocationTally {
  inferenceCalls: number;
  toolCalls: number;
}

/**
 * Call counts keyed by the invocation they belong to.
 *
 * adk-python carries this tally on an OpenTelemetry context key, which adk-js
 * cannot do: a context key reads back as unset unless a `ContextManager` is
 * registered, and one is only installed as a side effect of enabling tracing.
 * A metrics-only deployment would then report zero calls forever. Keying on
 * the invocation object gives the same innermost-wins scoping, because an
 * agent builds a fresh `InvocationContext` per invocation and threads that one
 * object down to its model and tool calls. The map is weak so an abandoned
 * invocation is not retained.
 */
const tallies = new WeakMap<InvocationContext, InvocationTally>();

/** Starts counting the model and tool calls of one agent invocation. */
export function beginAgentInvocationTally(ctx: InvocationContext): void {
  tallies.set(ctx, {inferenceCalls: 0, toolCalls: 0});
}

/** Counts one model call against its invocation, if it is being tallied. */
export function countInferenceCall(ctx: InvocationContext): void {
  const tally = tallies.get(ctx);
  if (tally) {
    tally.inferenceCalls++;
  }
}

/** Counts one tool call against its invocation, if it is being tallied. */
export function countToolCall(ctx: InvocationContext): void {
  const tally = tallies.get(ctx);
  if (tally) {
    tally.toolCalls++;
  }
}

/**
 * Records the call counts of a finished agent invocation and stops tallying
 * it. Zero is a real observation, so an invocation that called nothing still
 * records a point on both histograms.
 */
export function flushAgentInvocationTally(
  ctx: InvocationContext,
  agentName: string,
): void {
  const tally = tallies.get(ctx);
  if (!tally) {
    return;
  }
  tallies.delete(ctx);
  recordInvokeAgentInferenceCalls(agentName, tally.inferenceCalls);
  recordInvokeAgentToolCalls(agentName, tally.toolCalls);
}

/**
 * Records the duration of a workflow invocation, in seconds.
 *
 * @param params.nested Whether the workflow ran below another node. A root
 *     workflow omits the attribute entirely rather than reporting `false`, so
 *     that a query for nested runs does not have to exclude the roots.
 */
export function recordWorkflowInvocationDuration(params: {
  workflowName: string;
  elapsedS: number;
  nested: boolean;
  error?: unknown;
}): void {
  safeRecord('workflow invocation duration', () => {
    const {workflowName, elapsedS, nested, error} = params;
    const attributes: Attributes = {
      [GEN_AI_OPERATION_NAME]: 'invoke_workflow',
    };
    if (nested) {
      attributes[GEN_AI_WORKFLOW_NESTED] = true;
    }
    if (error !== undefined) {
      attributes[ERROR_TYPE] = resolveErrorType(error);
    }
    if (workflowName) {
      attributes[GEN_AI_WORKFLOW_NAME] = workflowName;
    }
    histogram('workflowInvocationDuration').record(elapsedS, attributes);
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

/**
 * Records the duration of a tool execution, in seconds.
 *
 * @param error The value the tool threw, if it threw one.
 * @param errorType A failure a tool reported in its response without throwing.
 *     A thrown error describes the failure better, so it wins when both are
 *     present.
 */
export function recordToolExecutionDuration(
  toolName: string,
  toolType: string,
  agentName: string,
  elapsedS: number,
  error?: unknown,
  errorType?: string,
): void {
  safeRecord('tool execution duration', () => {
    const attributes: Attributes = {
      [GEN_AI_AGENT_NAME]: agentName,
      [GEN_AI_TOOL_NAME]: toolName,
      [GEN_AI_TOOL_TYPE]: toolType,
    };
    if (error !== undefined) {
      attributes[ERROR_TYPE] = resolveErrorType(error);
    } else if (errorType !== undefined) {
      attributes[ERROR_TYPE] = errorType;
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
