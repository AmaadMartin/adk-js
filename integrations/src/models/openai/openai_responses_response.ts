/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger, LlmResponse} from '@google/adk';
import {
  FinishReason,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';
import {Buffer} from 'node:buffer';
import type {
  Response,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseUsage,
} from 'openai/resources/responses/responses';
import {loadJsonObject} from './openai_responses_request.js';
import {JsonObject} from './openai_schema.js';

const logger = getLogger();

/** Prefix applied to the text of a model refusal. */
export const REFUSAL_PREFIX = 'OpenAI refusal: ';

/** Incomplete reasons the Responses API uses for an output-token cutoff. */
const MAX_TOKEN_REASONS = ['max_output_tokens', 'max_tokens'];

/**
 * The Responses fields this converter reads.
 *
 * The SDK types `usage` and `status` as always present on a completed
 * response, but a streamed or partially built response can omit either, so the
 * converter accepts the relaxed shape.
 */
export type ResponseLike = Partial<Response>;

/** Metadata collected from one reasoning output item. */
export interface ReasoningMetadata {
  encrypted_content?: string;
  id?: string;
}

/** Options controlling how much of the raw response is surfaced. */
export interface ResponseConversionOptions {
  includeResponseMetadata: boolean;
}

/** Maps Responses token usage onto the ADK usage metadata. */
export function usageMetadata(
  usage?: Partial<ResponseUsage>,
): GenerateContentResponseUsageMetadata | undefined {
  if (!usage) {
    return undefined;
  }
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  let totalTokens = usage.total_tokens;
  if (
    totalTokens === undefined &&
    inputTokens !== undefined &&
    outputTokens !== undefined
  ) {
    totalTokens = inputTokens + outputTokens;
  }
  return {
    promptTokenCount: inputTokens,
    candidatesTokenCount: outputTokens,
    totalTokenCount: totalTokens,
    cachedContentTokenCount: usage.input_tokens_details?.cached_tokens,
    thoughtsTokenCount: usage.output_tokens_details?.reasoning_tokens,
  };
}

/** Maps a Responses status onto the ADK finish reason. */
export function mapFinishReason(
  response: ResponseLike,
): FinishReason | undefined {
  switch (response.status) {
    case 'completed':
      return FinishReason.STOP;
    case 'incomplete':
      return MAX_TOKEN_REASONS.includes(
        response.incomplete_details?.reason ?? '',
      )
        ? FinishReason.MAX_TOKENS
        : FinishReason.OTHER;
    case 'failed':
    case 'cancelled':
      return FinishReason.OTHER;
    default:
      return undefined;
  }
}

/** Converts the content blocks of an output message into ADK parts. */
export function messageContentParts(item: ResponseOutputMessage): Part[] {
  const parts: Part[] = [];
  for (const content of item.content) {
    switch (content.type) {
      case 'output_text':
        if (content.text) {
          parts.push({text: content.text});
        }
        break;
      case 'refusal':
        if (content.refusal) {
          parts.push({text: REFUSAL_PREFIX + content.refusal});
        }
        break;
    }
  }
  return parts;
}

/**
 * Converts a reasoning output item into ADK thought parts plus its metadata.
 *
 * genai carries a thought signature as a base64 string where adk-python
 * carries raw bytes, so the encrypted content is base64-encoded here.
 */
export function reasoningParts(item: ResponseReasoningItem): {
  parts: Part[];
  metadata: ReasoningMetadata;
} {
  const encryptedContent = item.encrypted_content ?? undefined;
  const thoughtSignature = encryptedContent
    ? Buffer.from(encryptedContent, 'utf-8').toString('base64')
    : undefined;
  const parts: Part[] = [];
  for (const entry of [...item.summary, ...(item.content ?? [])]) {
    if (entry.text) {
      parts.push({text: entry.text, thought: true, thoughtSignature});
    }
  }
  const metadata: ReasoningMetadata = {};
  if (encryptedContent) {
    metadata.encrypted_content = encryptedContent;
    if (parts.length === 0) {
      parts.push({thought: true, thoughtSignature});
    }
  }
  if (item.id) {
    metadata.id = item.id;
  }
  return {parts, metadata};
}

/** Converts a function tool call output item into an ADK part. */
export function functionCallPart(item: ResponseFunctionToolCall): Part {
  if (!item.name) {
    logger.warn('OpenAI Responses function call is missing a name.');
  }
  return {
    functionCall: {
      id: item.call_id || item.id,
      name: item.name,
      args: loadJsonObject(item.arguments),
    },
  };
}

/** The parts and metadata accumulated while walking the response output. */
interface ConvertedOutput {
  parts: Part[];
  outputMetadata: ResponseOutputItem[];
  reasoningMetadata: ReasoningMetadata[];
  unmappedOutput: ResponseOutputItem[];
}

/** Converts every output item of a response into ADK parts. */
function convertOutput(output: ResponseOutputItem[]): ConvertedOutput {
  const converted: ConvertedOutput = {
    parts: [],
    outputMetadata: [],
    reasoningMetadata: [],
    unmappedOutput: [],
  };
  for (const item of output) {
    switch (item.type) {
      case 'message':
        converted.parts.push(...messageContentParts(item));
        break;
      case 'function_call':
        converted.parts.push(functionCallPart(item));
        break;
      case 'reasoning': {
        const {parts, metadata} = reasoningParts(item);
        converted.parts.push(...parts);
        if (Object.keys(metadata).length > 0) {
          converted.reasoningMetadata.push(metadata);
        }
        break;
      }
      default:
        converted.unmappedOutput.push(item);
        break;
    }
    converted.outputMetadata.push(item);
  }
  return converted;
}

/** Builds the raw-response metadata surfaced on the ADK response. */
function responseMetadata(
  response: ResponseLike,
  converted: ConvertedOutput,
): JsonObject {
  const openaiResponse: JsonObject = {
    id: response.id,
    status: response.status,
    output: converted.outputMetadata,
  };
  if (response.usage) {
    openaiResponse['usage'] = response.usage;
  }
  if (converted.reasoningMetadata.length > 0) {
    openaiResponse['reasoning'] = converted.reasoningMetadata;
  }
  if (converted.unmappedOutput.length > 0) {
    openaiResponse['unmapped_output'] = converted.unmappedOutput;
  }
  return {openai_response: openaiResponse};
}

/** Converts a Responses API response into an ADK response. */
export function responseToLlmResponse(
  response: ResponseLike,
  options: ResponseConversionOptions,
): LlmResponse {
  const converted = convertOutput(response.output ?? []);
  const finishReason = mapFinishReason(response);
  const llmResponse: LlmResponse = {
    content:
      converted.parts.length > 0
        ? {role: 'model', parts: converted.parts}
        : undefined,
    usageMetadata: usageMetadata(response.usage),
    finishReason,
    modelVersion: response.model,
    interactionId: response.id,
    customMetadata: options.includeResponseMetadata
      ? responseMetadata(response, converted)
      : undefined,
  };
  if (finishReason && finishReason !== FinishReason.STOP) {
    const error = response.error ?? response.incomplete_details;
    llmResponse.errorCode = finishReason;
    llmResponse.errorMessage = error ? JSON.stringify(error) : undefined;
  }
  return llmResponse;
}
