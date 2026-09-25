/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OciChatClient} from '@google/adk/models/oci_genai_llm.js';
import type {models, requests, responses} from 'oci-generativeaiinference';
import {vi} from 'vitest';

/** Options for {@link makeOciResponse}. */
export interface OciResponseOptions {
  text?: string;
  toolCalls?: models.FunctionCall[];
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  /** Replaces the single default choice, for shapes `text` cannot build. */
  choices?: models.ChatChoice[];
}

/** Builds a non-streaming OCI chat response with one choice. */
export function makeOciResponse({
  text = 'Hello from OCI.',
  toolCalls = [],
  promptTokens = 10,
  completionTokens = 5,
  reasoningTokens,
  choices,
}: OciResponseOptions = {}): responses.ChatResponse {
  const textBlock: models.TextContent = {type: 'TEXT', text};
  const message: models.AssistantMessage = {
    role: 'ASSISTANT',
    content: text ? [textBlock] : [],
    toolCalls,
  };
  const chatResponse: models.GenericChatResponse = {
    apiFormat: 'GENERIC',
    timeCreated: new Date(0),
    choices: choices ?? [{index: 0, message, finishReason: 'stop'}],
    usage: {
      promptTokens,
      completionTokens,
      completionTokensDetails:
        reasoningTokens === undefined ? undefined : {reasoningTokens},
    },
  };
  return {
    etag: 'etag',
    opcRequestId: 'opc-request-id',
    modelDeprecationInfo: '',
    chatResult: {
      modelId: 'model-id',
      modelVersion: '1.0',
      chatResponse,
    },
  };
}

/** Builds a non-streaming response whose single choice is one tool call. */
export function makeToolCallResponse(
  name: string,
  args: Record<string, unknown>,
  id = 'call_abc123',
): responses.ChatResponse {
  return makeOciResponse({
    text: '',
    toolCalls: [{id, type: 'FUNCTION', name, arguments: JSON.stringify(args)}],
    promptTokens: 20,
    completionTokens: 15,
  });
}

/** A streamed tool call, as {@link makeStreamChunks} emits it. */
export interface StreamToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Options for {@link makeStreamChunks}. */
export interface StreamChunkOptions {
  textTokens?: string[];
  toolCalls?: StreamToolCall[];
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
}

/**
 * Builds the chunk objects of an OCI GenericChat stream, in the camelCase
 * spelling the `/20231130/` schema uses on the wire.
 */
export function makeStreamChunks({
  textTokens = [],
  toolCalls = [],
  promptTokens = 10,
  completionTokens = 5,
  reasoningTokens,
}: StreamChunkOptions = {}): Array<Record<string, unknown>> {
  const chunks: Array<Record<string, unknown>> = textTokens.map((token) => ({
    index: 0,
    message: {role: 'ASSISTANT', content: [{type: 'TEXT', text: token}]},
  }));
  for (const call of toolCalls) {
    chunks.push({
      index: 0,
      message: {
        role: 'ASSISTANT',
        toolCalls: [
          {
            type: 'FUNCTION',
            id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.args),
          },
        ],
      },
    });
  }
  chunks.push({finishReason: 'stop'});
  chunks.push({
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      ...(reasoningTokens === undefined
        ? {}
        : {completionTokensDetails: {reasoningTokens}}),
    },
  });
  return chunks;
}

/** Wraps raw server-sent event text in a stream, one enqueue per element. */
export function sseStreamFromText(
  chunks: string[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

/** Frames each chunk as one server-sent event, then the `[DONE]` sentinel. */
export function sseStreamFrom(
  chunks: Array<Record<string, unknown>>,
): ReadableStream<Uint8Array> {
  return sseStreamFromText([
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    'data: [DONE]\n\n',
  ]);
}

/**
 * The prose of a message's first content block.
 *
 * `models.ChatContent` declares only `type`, so the SDK gives a test no typed
 * way to reach the text of a block.
 */
export function firstText(message: models.Message): string | undefined {
  const block = message.content?.[0];
  const text = block && 'text' in block ? block.text : undefined;
  return typeof text === 'string' ? text : undefined;
}

/** The URL a media content block carries, whatever kind of media it holds. */
export function mediaUrl(block: models.ChatContent): string | undefined {
  for (const key of ['imageUrl', 'audioUrl', 'videoUrl', 'documentUrl']) {
    const value = key in block ? (block as Record<string, unknown>)[key] : null;
    if (value && typeof value === 'object' && 'url' in value) {
      const url = (value as {url: unknown}).url;
      return typeof url === 'string' ? url : undefined;
    }
  }
  return undefined;
}

/** The tool-call id a tool message answers. */
export function toolCallId(message: models.Message): string | undefined {
  return (message as models.ToolMessage).toolCallId;
}

/** The function calls an assistant message carries. */
export function toolCallsOf(message: models.Message): models.FunctionCall[] {
  const calls = (message as models.AssistantMessage).toolCalls ?? [];
  return calls.filter(
    (call): call is models.FunctionCall => call.type === 'FUNCTION',
  );
}

/** Narrows a tool definition to the function variant that carries a name. */
export function isFunctionDefinition(
  tool?: models.ToolDefinition,
): tool is models.FunctionDefinition {
  return tool?.type === 'FUNCTION';
}

/** Narrows a serving mode to the dedicated-endpoint variant. */
export function isDedicatedServing(
  mode: models.ChatDetails['servingMode'],
): mode is models.DedicatedServingMode {
  return mode.servingType === 'DEDICATED';
}

/** Narrows a serving mode to the on-demand variant. */
export function isOnDemandServing(
  mode: models.ChatDetails['servingMode'],
): mode is models.OnDemandServingMode {
  return mode.servingType === 'ON_DEMAND';
}

/** Narrows a response format to the JSON-schema variant. */
export function isJsonSchemaFormat(
  format: models.GenericChatRequest['responseFormat'],
): format is models.JsonSchemaResponseFormat {
  return format?.type === 'JSON_SCHEMA';
}

/** Narrows a chat request to the GenericChat shape the provider sends. */
export function isGenericChatRequest(
  request: models.ChatDetails['chatRequest'],
): request is models.GenericChatRequest {
  return request.apiFormat === 'GENERIC';
}

/** An inference client that answers every call with the same canned body. */
export interface FakeOciClient extends OciChatClient {
  chat: ReturnType<typeof vi.fn>;
  /** The chat details of the most recent call. */
  lastChatDetails(): models.ChatDetails;
  /** The GenericChat request of the most recent call. */
  lastChatRequest(): models.GenericChatRequest;
}

/**
 * Builds an inference client that returns `body` — or the next body in turn,
 * when several are given — and records what it was asked.
 */
export function fakeOciClient(
  ...bodies: Array<responses.ChatResponse | ReadableStream<Uint8Array> | null>
): FakeOciClient {
  let call = 0;
  const chat = vi.fn(async (_chatRequest: requests.ChatRequest) => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return body;
  });
  const detailsOf = (index: number): models.ChatDetails => {
    const args = chat.mock.calls[index];
    if (!args) {
      throw new Error(`The fake client was not called ${index + 1} times.`);
    }
    return args[0].chatDetails;
  };
  return {
    chat,
    lastChatDetails: () => detailsOf(chat.mock.calls.length - 1),
    lastChatRequest: () => {
      const request = detailsOf(chat.mock.calls.length - 1).chatRequest;
      if (!isGenericChatRequest(request)) {
        throw new Error(
          `Expected a GenericChatRequest, got ${request.apiFormat}.`,
        );
      }
      return request;
    },
  };
}
