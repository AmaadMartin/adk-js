/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';
import {Histogram, Meter, metrics} from '@opentelemetry/api';

import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {logger} from '../utils/logger.js';
import {getGoogleLlmVariant, GoogleLLMVariant} from '../utils/variant_utils.js';
import {version} from '../version.js';

let meter: Meter | undefined;
function getMeter(): Meter {
  if (!meter) {
    meter = metrics.getMeter('gcp.vertex.agent', version);
  }
  return meter;
}

/**
 * Name, unit and description of every histogram recorded by this module.
 */
const HISTOGRAMS = {
  agentInvocationDuration: {
    name: 'gen_ai.agent.invocation.duration',
    unit: 'ms',
    description: 'Duration of agent invocations.',
  },
  toolExecutionDuration: {
    name: 'gen_ai.tool.execution.duration',
    unit: 'ms',
    description: 'Duration of tool executions.',
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
  clientOperationDuration: {
    name: 'gen_ai.client.operation.duration',
    unit: 's',
    description: 'Duration of client operations.',
  },
  clientTokenUsage: {
    name: 'gen_ai.client.token.usage',
    unit: '1',
    description: 'Token usage of client operations.',
  },
} as const;

type HistogramKey = keyof typeof HISTOGRAMS;

const instruments = new Map<HistogramKey, Histogram>();

/**
 * Returns the histogram for `key`, creating it on first use so that no
 * instrument is registered until a metric is actually recorded.
 */
function histogram(key: HistogramKey): Histogram {
  let instrument = instruments.get(key);
  if (!instrument) {
    const {name, unit, description} = HISTOGRAMS[key];
    instrument = getMeter().createHistogram(name, {unit, description});
    instruments.set(key, instrument);
  }
  return instrument;
}

const textEncoder = new TextEncoder();

function getBase64ByteLength(base64String: string): number {
  const len = base64String.length;
  let padding = 0;
  if (base64String.endsWith('==')) {
    padding = 2;
  } else if (base64String.endsWith('=')) {
    padding = 1;
  }
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Part fields whose payload is structured rather than text or inline bytes.
 * Their wire size is approximated by the size of their JSON encoding.
 */
const STRUCTURED_PART_FIELDS = [
  'functionCall',
  'functionResponse',
  'fileData',
  'executableCode',
  'codeExecutionResult',
] as const;

function getPartSize(part: Part): number {
  let size = 0;
  if (part.text !== undefined && part.text !== null) {
    size += textEncoder.encode(part.text).length;
  }
  if (part.inlineData?.data) {
    size += getBase64ByteLength(part.inlineData.data);
  }
  for (const field of STRUCTURED_PART_FIELDS) {
    const payload = part[field];
    if (payload !== undefined && payload !== null) {
      size += textEncoder.encode(JSON.stringify(payload)).length;
    }
  }
  return size;
}

/**
 * Approximate size of `content` in bytes: UTF-8 bytes for text, decoded bytes
 * for inline blobs, and the UTF-8 size of the JSON encoding for structured
 * parts (function calls and responses, file references, executable code and
 * its results).
 *
 * Structured parts are counted so that a tool-calling turn, whose content is
 * often a single `functionCall` part, is not reported as 0 bytes: a dashboard
 * cannot tell such a reading apart from an unmeasured response.
 */
function getContentSize(content?: Content | null): number {
  if (!content || !content.parts) {
    return 0;
  }
  let size = 0;
  for (const part of content.parts) {
    size += getPartSize(part);
  }
  return size;
}

function getProviderName(): string {
  try {
    return getGoogleLlmVariant() === GoogleLLMVariant.VERTEX_AI
      ? 'vertex_ai'
      : 'gemini';
  } catch (_e) {
    return 'gemini';
  }
}

export function recordAgentInvocationDuration(
  agentName: string,
  elapsedMs: number,
  error?: Error,
): void {
  try {
    const attributes: Record<string, string> = {
      'gen_ai.agent.name': agentName,
    };
    if (error) {
      attributes['error.type'] = error.name || error.constructor.name;
    }
    histogram('agentInvocationDuration').record(elapsedMs, attributes);
  } catch (e) {
    logger.debug('Failed to record agent invocation duration', e);
  }
}

export function recordAgentRequestSize(
  agentName: string,
  userContent?: Content | null,
): void {
  try {
    const size = getContentSize(userContent);
    const attributes = {
      'gen_ai.agent.name': agentName,
    };
    histogram('agentRequestSize').record(size, attributes);
  } catch (e) {
    logger.debug('Failed to record agent request size', e);
  }
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
  try {
    const size = getContentSize(responseContent);
    const attributes = {
      'gen_ai.agent.name': agentName,
    };
    histogram('agentResponseSize').record(size, attributes);
  } catch (e) {
    logger.debug('Failed to record agent response size', e);
  }
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
  try {
    const attributes = {
      'gen_ai.agent.name': agentName,
    };
    histogram('agentWorkflowSteps').record(stepCount, attributes);
  } catch (e) {
    logger.debug('Failed to record agent workflow steps', e);
  }
}

export function recordToolExecutionDuration(
  toolName: string,
  agentName: string,
  elapsedMs: number,
  error?: Error,
): void {
  try {
    const attributes: Record<string, string> = {
      'gen_ai.agent.name': agentName,
      'gen_ai.tool.name': toolName,
    };
    if (error) {
      attributes['error.type'] = error.name || error.constructor.name;
    }
    histogram('toolExecutionDuration').record(elapsedMs, attributes);
  } catch (e) {
    logger.debug('Failed to record tool execution duration', e);
  }
}

/**
 * Records the duration of a call to the model.
 *
 * @param lastResponse The final response of the call, if one was produced.
 *     Only the last response carries the model version and token counts of the
 *     whole call, so intermediate streaming chunks are not needed here.
 */
export function recordClientOperationDuration(
  agentName: string,
  elapsedMs: number,
  llmRequest: LlmRequest,
  lastResponse?: LlmResponse,
  error?: Error,
): void {
  try {
    const attributes: Record<string, string> = {
      'gen_ai.agent.name': agentName,
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': getProviderName(),
    };
    if (llmRequest.model) {
      attributes['gen_ai.request.model'] = llmRequest.model;
    }
    if (lastResponse) {
      const responseModel = lastResponse.modelVersion || llmRequest.model;
      if (responseModel) {
        attributes['gen_ai.response.model'] = responseModel;
      }
    }
    if (error) {
      attributes['error.type'] = error.name || error.constructor.name;
    }
    histogram('clientOperationDuration').record(elapsedMs / 1000.0, attributes);
  } catch (e) {
    logger.debug('Failed to record client operation duration', e);
  }
}

/**
 * Records the token usage of a call to the model.
 *
 * @param lastResponse The final response of the call, if one was produced. Its
 *     `usageMetadata` covers the whole call.
 */
export function recordClientTokenUsage(
  agentName: string,
  llmRequest: LlmRequest,
  lastResponse?: LlmResponse,
): void {
  try {
    if (!lastResponse) {
      return;
    }
    if (!lastResponse.usageMetadata) {
      logger.debug(
        `Skipping missing token usage metadata for agent ${agentName} and model ${llmRequest.model}`,
      );
      return;
    }

    const promptTokens = lastResponse.usageMetadata.promptTokenCount || 0;
    const toolTokens = lastResponse.usageMetadata.toolUsePromptTokenCount || 0;
    const inputTokenCount = promptTokens + toolTokens;

    const candidatesTokens =
      lastResponse.usageMetadata.candidatesTokenCount || 0;
    const thoughtsTokens = lastResponse.usageMetadata.thoughtsTokenCount || 0;
    const outputTokenCount = candidatesTokens + thoughtsTokens;

    const responseModel = lastResponse.modelVersion || llmRequest.model;

    const baseAttributes: Record<string, string> = {
      'gen_ai.agent.name': agentName,
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': getProviderName(),
    };
    if (llmRequest.model) {
      baseAttributes['gen_ai.request.model'] = llmRequest.model;
    }
    if (responseModel) {
      baseAttributes['gen_ai.response.model'] = responseModel;
    }

    if (inputTokenCount > 0) {
      const inputAttributes = {
        ...baseAttributes,
        'gen_ai.token.type': 'input',
      };
      histogram('clientTokenUsage').record(inputTokenCount, inputAttributes);
    }

    if (outputTokenCount > 0) {
      const outputAttributes = {
        ...baseAttributes,
        'gen_ai.token.type': 'output',
      };
      histogram('clientTokenUsage').record(outputTokenCount, outputAttributes);
    }
  } catch (e) {
    logger.debug('Failed to record client token usage', e);
  }
}
