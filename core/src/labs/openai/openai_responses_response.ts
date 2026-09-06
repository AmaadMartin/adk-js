/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts OpenAI Responses API replies into ADK responses.
 *
 * Ports the response half of adk-python
 * `src/google/adk/labs/openai/_openai_responses_llm.py`.
 */

import {
  Content,
  FinishReason,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';
import type OpenAI from 'openai';

import {LlmResponse} from '../../models/llm_response.js';
import {logger} from '../../utils/logger.js';

import {isJsonObject} from './openai_schema.js';

/** Prefix added to a refusal so it survives as readable model text. */
const REFUSAL_PREFIX = 'OpenAI refusal: ';

/** Incomplete reasons that mean the output token limit was reached. */
const MAX_TOKEN_REASONS: ReadonlySet<string> = new Set([
  'max_output_tokens',
  'max_tokens',
]);

/**
 * Token usage as reported by the provider.
 *
 * Every field is optional because an OpenAI-compatible host may report only
 * part of the usage block, which the reference implementation also tolerates.
 */
export type ReportedUsage = Partial<OpenAI.Responses.ResponseUsage>;

/** Metadata recorded for one reasoning output item. */
export interface ReasoningMetadata {
  encrypted_content?: string;
  id?: string;
}

/**
 * Parses a function call's arguments.
 *
 * The model produces this JSON, so a malformed or non-object payload is
 * reported and degraded to an empty argument set rather than failing the turn.
 */
export function loadsJsonObject(
  value: string | undefined,
): Record<string, unknown> {
  if (!value) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    logger.warn('Failed to parse Responses API function arguments as JSON.');
    return {};
  }
  return isJsonObject(parsed) ? parsed : {};
}

/** Converts a message output item into ADK text parts. */
export function messageContentParts(
  item: OpenAI.Responses.ResponseOutputMessage,
): Part[] {
  const parts: Part[] = [];
  for (const content of item.content) {
    if (content.type === 'output_text' && content.text) {
      parts.push({text: content.text});
    } else if (content.type === 'refusal' && content.refusal) {
      parts.push({text: REFUSAL_PREFIX + content.refusal});
    }
  }
  return parts;
}

/**
 * Encodes an encrypted reasoning payload as an ADK thought signature.
 *
 * `Part.thoughtSignature` is a base64 string in `@google/genai` where the
 * reference implementation holds raw bytes, so the UTF-8 bytes of the
 * encrypted content are base64-encoded here.
 */
function encodeThoughtSignature(encryptedContent: string): string {
  return Buffer.from(encryptedContent, 'utf-8').toString('base64');
}

/**
 * Converts a reasoning output item into ADK thought parts.
 *
 * @return The thought parts, and the metadata recorded for the item.
 */
export function reasoningParts(item: OpenAI.Responses.ResponseReasoningItem): {
  parts: Part[];
  metadata: ReasoningMetadata;
} {
  const encrypted = item.encrypted_content
    ? {
        content: item.encrypted_content,
        signature: encodeThoughtSignature(item.encrypted_content),
      }
    : undefined;

  const parts: Part[] = [];
  for (const entry of [...item.summary, ...(item.content ?? [])]) {
    if (entry.text) {
      const part: Part = {text: entry.text, thought: true};
      if (encrypted) {
        part.thoughtSignature = encrypted.signature;
      }
      parts.push(part);
    }
  }

  const metadata: ReasoningMetadata = {};
  if (encrypted) {
    metadata.encrypted_content = encrypted.content;
    if (parts.length === 0) {
      parts.push({thought: true, thoughtSignature: encrypted.signature});
    }
  }
  if (item.id) {
    metadata.id = item.id;
  }
  return {parts, metadata};
}

/** Converts a function-call output item into an ADK function-call part. */
export function functionCallPart(
  item: OpenAI.Responses.ResponseFunctionToolCall,
): Part {
  if (!item.name) {
    logger.warn('OpenAI Responses function call is missing a name.');
  }
  return {
    functionCall: {
      id: item.call_id || item.id,
      name: item.name,
      args: loadsJsonObject(item.arguments),
    },
  };
}

/** Converts reported token usage into ADK usage metadata. */
export function toUsageMetadata(
  usage: ReportedUsage | undefined,
): GenerateContentResponseUsageMetadata | undefined {
  if (!usage) {
    return undefined;
  }
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const totalTokens =
    usage.total_tokens ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  return {
    promptTokenCount: inputTokens,
    candidatesTokenCount: outputTokens,
    totalTokenCount: totalTokens,
    cachedContentTokenCount: usage.input_tokens_details?.cached_tokens,
    thoughtsTokenCount: usage.output_tokens_details?.reasoning_tokens,
  };
}

/** Maps a response status onto an ADK finish reason. */
export function mapFinishReason(
  response: OpenAI.Responses.Response,
): FinishReason | undefined {
  switch (response.status) {
    case 'completed':
      return FinishReason.STOP;
    case 'incomplete': {
      const reason = response.incomplete_details?.reason;
      return reason !== undefined && MAX_TOKEN_REASONS.has(reason)
        ? FinishReason.MAX_TOKENS
        : FinishReason.OTHER;
    }
    case 'failed':
    case 'cancelled':
      return FinishReason.OTHER;
    default:
      return undefined;
  }
}

/** The parts and metadata collected from a response's output items. */
interface CollectedOutput {
  parts: Part[];
  reasoning: ReasoningMetadata[];
  unmapped: OpenAI.Responses.ResponseOutputItem[];
}

/** Splits a response's output items into ADK parts and recorded metadata. */
function collectOutput(
  output: OpenAI.Responses.ResponseOutputItem[],
): CollectedOutput {
  const collected: CollectedOutput = {parts: [], reasoning: [], unmapped: []};
  for (const item of output) {
    switch (item.type) {
      case 'message':
        collected.parts.push(...messageContentParts(item));
        break;
      case 'function_call':
        collected.parts.push(functionCallPart(item));
        break;
      case 'reasoning': {
        const {parts, metadata} = reasoningParts(item);
        collected.parts.push(...parts);
        if (Object.keys(metadata).length > 0) {
          collected.reasoning.push(metadata);
        }
        break;
      }
      default:
        collected.unmapped.push(item);
        break;
    }
  }
  return collected;
}

/**
 * The `openai_response` metadata block.
 *
 * The keys stay snake_case: they carry the payload the Responses API sent, so
 * they are read back against OpenAI's own documentation.
 */
export interface OpenAiResponseMetadata {
  id?: string;
  status?: string;
  output: OpenAI.Responses.ResponseOutputItem[];
  usage?: ReportedUsage;
  reasoning?: ReasoningMetadata[];
  unmapped_output?: OpenAI.Responses.ResponseOutputItem[];
}

/** Converts a Responses API reply into an ADK response. */
export function responseToLlmResponse(
  response: OpenAI.Responses.Response,
  includeResponseMetadata: boolean,
): LlmResponse {
  const {parts, reasoning, unmapped} = collectOutput(response.output);
  const content: Content | undefined = parts.length
    ? {role: 'model', parts}
    : undefined;

  let customMetadata: {openai_response: OpenAiResponseMetadata} | undefined;
  if (includeResponseMetadata) {
    const metadata: OpenAiResponseMetadata = {
      id: response.id,
      status: response.status,
      output: response.output,
    };
    if (response.usage) {
      metadata.usage = response.usage;
    }
    if (reasoning.length > 0) {
      metadata.reasoning = reasoning;
    }
    if (unmapped.length > 0) {
      metadata.unmapped_output = unmapped;
    }
    customMetadata = {openai_response: metadata};
  }

  const finishReason = mapFinishReason(response);
  const llmResponse: LlmResponse = {
    content,
    usageMetadata: toUsageMetadata(response.usage),
    finishReason,
    modelVersion: response.model,
    interactionId: response.id,
    customMetadata,
  };

  if (finishReason && finishReason !== FinishReason.STOP) {
    const error = response.error ?? response.incomplete_details;
    llmResponse.errorCode = finishReason;
    llmResponse.errorMessage = error ? JSON.stringify(error) : undefined;
  }
  return llmResponse;
}
