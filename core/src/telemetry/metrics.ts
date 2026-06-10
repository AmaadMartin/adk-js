/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {Histogram, Meter, metrics} from '@opentelemetry/api';

import {Event} from '../events/event.js';
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

let agentInvocationDurationInst: Histogram | undefined;
function getAgentInvocationDuration(): Histogram {
  if (!agentInvocationDurationInst) {
    agentInvocationDurationInst = getMeter().createHistogram(
      'gen_ai.agent.invocation.duration',
      {
        unit: 'ms',
        description: 'Duration of agent invocations.',
      },
    );
  }
  return agentInvocationDurationInst;
}

let toolExecutionDurationInst: Histogram | undefined;
function getToolExecutionDuration(): Histogram {
  if (!toolExecutionDurationInst) {
    toolExecutionDurationInst = getMeter().createHistogram(
      'gen_ai.tool.execution.duration',
      {
        unit: 'ms',
        description: 'Duration of tool executions.',
      },
    );
  }
  return toolExecutionDurationInst;
}

let agentRequestSizeInst: Histogram | undefined;
function getAgentRequestSize(): Histogram {
  if (!agentRequestSizeInst) {
    agentRequestSizeInst = getMeter().createHistogram(
      'gen_ai.agent.request.size',
      {
        unit: 'By',
        description: 'Size of agent requests.',
      },
    );
  }
  return agentRequestSizeInst;
}

let agentResponseSizeInst: Histogram | undefined;
function getAgentResponseSize(): Histogram {
  if (!agentResponseSizeInst) {
    agentResponseSizeInst = getMeter().createHistogram(
      'gen_ai.agent.response.size',
      {
        unit: 'By',
        description: 'Size of agent responses.',
      },
    );
  }
  return agentResponseSizeInst;
}

let agentWorkflowStepsInst: Histogram | undefined;
function getAgentWorkflowSteps(): Histogram {
  if (!agentWorkflowStepsInst) {
    agentWorkflowStepsInst = getMeter().createHistogram(
      'gen_ai.agent.workflow.steps',
      {
        unit: '1',
        description: 'Length of agentic workflow (# of events).',
      },
    );
  }
  return agentWorkflowStepsInst;
}

let clientOperationDurationInst: Histogram | undefined;
function getClientOperationDuration(): Histogram {
  if (!clientOperationDurationInst) {
    clientOperationDurationInst = getMeter().createHistogram(
      'gen_ai.client.operation.duration',
      {
        unit: 's',
        description: 'Duration of client operations.',
      },
    );
  }
  return clientOperationDurationInst;
}

let clientTokenUsageInst: Histogram | undefined;
function getClientTokenUsage(): Histogram {
  if (!clientTokenUsageInst) {
    clientTokenUsageInst = getMeter().createHistogram(
      'gen_ai.client.token.usage',
      {
        unit: '1',
        description: 'Token usage of client operations.',
      },
    );
  }
  return clientTokenUsageInst;
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

function getContentSize(content?: Content | null): number {
  if (!content || !content.parts) {
    return 0;
  }
  let size = 0;
  for (const part of content.parts) {
    if (part.text !== undefined && part.text !== null) {
      size += textEncoder.encode(part.text).length;
    }
    if (part.inlineData?.data) {
      size += getBase64ByteLength(part.inlineData.data);
    }
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
    getAgentInvocationDuration().record(elapsedMs, attributes);
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
    getAgentRequestSize().record(size, attributes);
  } catch (e) {
    logger.debug('Failed to record agent request size', e);
  }
}

export function recordAgentResponseSize(
  agentName: string,
  events: Event[],
): void {
  try {
    let responseContent: Content | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.author === agentName && event.content) {
        responseContent = event.content;
        break;
      }
    }
    const size = getContentSize(responseContent);
    const attributes = {
      'gen_ai.agent.name': agentName,
    };
    getAgentResponseSize().record(size, attributes);
  } catch (e) {
    logger.debug('Failed to record agent response size', e);
  }
}

export function recordAgentWorkflowSteps(
  agentName: string,
  events: Event[],
): void {
  try {
    let count = 0;
    for (const event of events) {
      if (event.author === agentName) {
        count++;
      }
    }
    const attributes = {
      'gen_ai.agent.name': agentName,
    };
    getAgentWorkflowSteps().record(count, attributes);
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
    getToolExecutionDuration().record(elapsedMs, attributes);
  } catch (e) {
    logger.debug('Failed to record tool execution duration', e);
  }
}

export function recordClientOperationDuration(
  agentName: string,
  elapsedMs: number,
  llmRequest: LlmRequest,
  responses: LlmResponse[],
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
    if (responses && responses.length > 0) {
      const lastResponse = responses[responses.length - 1];
      const responseModel = lastResponse.modelVersion || llmRequest.model;
      if (responseModel) {
        attributes['gen_ai.response.model'] = responseModel;
      }
    }
    if (error) {
      attributes['error.type'] = error.name || error.constructor.name;
    }
    getClientOperationDuration().record(elapsedMs / 1000.0, attributes);
  } catch (e) {
    logger.debug('Failed to record client operation duration', e);
  }
}

export function recordClientTokenUsage(
  agentName: string,
  llmRequest: LlmRequest,
  responses: LlmResponse[],
): void {
  try {
    if (!responses || responses.length === 0) {
      return;
    }
    const lastResponse = responses[responses.length - 1];
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
      getClientTokenUsage().record(inputTokenCount, inputAttributes);
    }

    if (outputTokenCount > 0) {
      const outputAttributes = {
        ...baseAttributes,
        'gen_ai.token.type': 'output',
      };
      getClientTokenUsage().record(outputTokenCount, outputAttributes);
    }
  } catch (e) {
    logger.debug('Failed to record client token usage', e);
  }
}
