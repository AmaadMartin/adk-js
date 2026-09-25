/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionDeclaration, Part, Schema} from '@google/genai';

import {contentUnionToText} from '../utils/content_utils.js';
import {logger} from '../utils/logger.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * A tool call in the OpenAI chat-completions wire format.
 */
export interface ChatCompletionMessageToolCall {
  type: 'function';
  id?: string;
  function: {
    name?: string;
    arguments?: string;
  };
}

/**
 * A single content item of a multi-part chat-completions message.
 */
export type ChatCompletionContentPart =
  | {type: 'text'; text: string}
  | {type: 'image_url'; image_url: string}
  | {type: 'video_url'; video_url: string};

/**
 * Content of a chat-completions message: plain text or a list of parts.
 */
export type ChatCompletionContent = string | ChatCompletionContentPart[];

/**
 * A request message in the OpenAI chat-completions wire format.
 */
export type ChatCompletionMessage =
  | {role: 'tool'; tool_call_id?: string; content: string}
  | {role: 'user'; content: ChatCompletionContent}
  | {
      role: 'assistant';
      content: ChatCompletionContent;
      tool_calls?: ChatCompletionMessageToolCall[];
    }
  | {role: 'developer'; content: string};

/**
 * A function tool definition in the OpenAI chat-completions wire format.
 */
export interface ChatCompletionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * A message (or streaming delta) returned by a chat-completions model.
 */
export interface ChatCompletionResponseMessage {
  role?: string;
  content?: string | null;
  tool_calls?: ChatCompletionMessageToolCall[] | null;
}

/**
 * One choice of a chat-completions response.
 */
export interface ModelResponseChoice {
  message?: ChatCompletionResponseMessage;
  delta?: ChatCompletionResponseMessage;
  finish_reason?: string | null;
}

/**
 * A chat-completions response, or one chunk of a streamed response.
 */
export interface ModelResponse {
  choices?: ModelResponseChoice[];
}

/**
 * The request handed to a {@link LiteLlmClient}.
 */
export interface CompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  tools?: ChatCompletionTool[];
  stream?: boolean;
  /** Provider-specific arguments forwarded unchanged to the client. */
  additionalArgs: Record<string, unknown>;
}

/**
 * A client for an OpenAI-compatible chat-completions backend, such as a
 * LiteLLM proxy.
 */
export interface LiteLlmClient {
  /** Returns the complete response for a request. */
  acompletion(request: CompletionRequest): Promise<ModelResponse>;
  /** Returns the response for a streaming request as a sequence of chunks. */
  completion(request: CompletionRequest): AsyncIterable<ModelResponse>;
}

/**
 * A partial function call emitted while reading a model response.
 */
export interface FunctionChunk {
  id?: string;
  name?: string;
  args?: string;
}

/**
 * A piece of text emitted while reading a model response.
 */
export interface TextChunk {
  text: string;
}

/**
 * Parameters for constructing a {@link LiteLlm}.
 */
export interface LiteLlmParams {
  /** The model name, for example `openai/gpt-4o`. */
  model: string;
  /** The client that sends chat-completions requests. */
  llmClient: LiteLlmClient;
  /** Extra arguments forwarded to every client call. */
  additionalArgs?: Record<string, unknown>;
}

const RESERVED_COMPLETION_ARGS = ['messages', 'tools', 'stream'];

/**
 * Returns true if the chunk is a {@link TextChunk}.
 */
export function isTextChunk(
  chunk: TextChunk | FunctionChunk,
): chunk is TextChunk {
  return 'text' in chunk;
}

/**
 * Serializes a value to JSON, falling back to its string form when it cannot
 * be serialized.
 */
export function safeJsonSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Maps a `Content` role to a chat-completions role.
 */
export function toLiteLlmRole(role?: string): 'user' | 'assistant' {
  if (role === 'model' || role === 'assistant') {
    return 'assistant';
  }
  return 'user';
}

/**
 * Converts `Part`s to chat-completions content. A single text part becomes a
 * plain string; anything else becomes a list of content parts.
 *
 * @throws Error if an inline data part has a MIME type other than image or
 *     video.
 */
export function getContent(parts: Part[]): ChatCompletionContent {
  const contentObjects: ChatCompletionContentPart[] = [];
  for (const part of parts) {
    if (part.text) {
      if (parts.length === 1) {
        return part.text;
      }
      contentObjects.push({type: 'text', text: part.text});
    } else if (part.inlineData?.data && part.inlineData.mimeType) {
      const mimeType = part.inlineData.mimeType;
      const dataUri = `data:${mimeType};base64,${part.inlineData.data}`;
      switch (mimeType.split('/')[0]) {
        case 'image':
          contentObjects.push({type: 'image_url', image_url: dataUri});
          break;
        case 'video':
          contentObjects.push({type: 'video_url', video_url: dataUri});
          break;
        default:
          throw new Error(
            'LiteLlm(BaseLlm) does not support this content part.',
          );
      }
    }
  }
  return contentObjects;
}

/**
 * Converts a `Content` to a chat-completions message.
 */
export function contentToMessageParam(content: Content): ChatCompletionMessage {
  const parts = content.parts ?? [];
  const functionResponse = parts[0]?.functionResponse;
  if (functionResponse) {
    return {
      role: 'tool',
      tool_call_id: functionResponse.id,
      content: safeJsonSerialize(functionResponse.response),
    };
  }

  if (toLiteLlmRole(content.role) === 'user') {
    return {role: 'user', content: getContent(parts)};
  }

  const toolCalls: ChatCompletionMessageToolCall[] = [];
  for (const part of parts) {
    if (part.functionCall) {
      toolCalls.push({
        type: 'function',
        id: part.functionCall.id,
        function: {
          name: part.functionCall.name,
          arguments: safeJsonSerialize(part.functionCall.args),
        },
      });
    }
  }

  return {
    role: 'assistant',
    content: getContent(parts),
    ...(toolCalls.length > 0 ? {tool_calls: toolCalls} : {}),
  };
}

/**
 * Converts a `Schema` to a JSON-schema dictionary with lowercase type names.
 */
export function schemaToDict(schema: Schema): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (value !== undefined && value !== null) {
      result[key] = value;
    }
  }
  if (schema.type) {
    result['type'] = schema.type.toLowerCase();
  }
  if (schema.items) {
    result['items'] = schemaToDict(schema.items);
  }
  if (schema.properties) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      properties[key] = schemaToDict(value);
    }
    result['properties'] = properties;
  }
  return result;
}

/**
 * Converts a `FunctionDeclaration` to a chat-completions tool definition.
 *
 * @throws Error if the declaration has no name.
 */
export function functionDeclarationToToolParam(
  functionDeclaration: FunctionDeclaration,
): ChatCompletionTool {
  if (!functionDeclaration.name) {
    throw new Error('Function declaration must have a name.');
  }

  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    functionDeclaration.parameters?.properties ?? {},
  )) {
    properties[key] = schemaToDict(value);
  }

  const parameters: Record<string, unknown> = {type: 'object', properties};
  const required = functionDeclaration.parameters?.required;
  if (required && required.length > 0) {
    parameters['required'] = required;
  }

  return {
    type: 'function',
    function: {
      name: functionDeclaration.name,
      description: functionDeclaration.description ?? '',
      parameters,
    },
  };
}

/**
 * Splits a model response (or streamed chunk) into text and function chunks,
 * each paired with the choice's finish reason.
 */
export function* modelResponseToChunk(
  response: ModelResponse,
): Generator<[TextChunk | FunctionChunk | null, string | null]> {
  const choice = response.choices?.[0];
  const message = choice?.message ?? choice?.delta;
  if (!choice || !message) {
    yield [null, null];
    return;
  }

  const finishReason = choice.finish_reason ?? null;
  if (message.content) {
    yield [{text: message.content}, finishReason];
  }
  for (const toolCall of message.tool_calls ?? []) {
    if (toolCall.type === 'function') {
      yield [
        {
          id: toolCall.id,
          name: toolCall.function.name,
          args: toolCall.function.arguments,
        },
        finishReason,
      ];
    }
  }
  if (finishReason && !message.content && !message.tool_calls?.length) {
    yield [null, finishReason];
  }
}

/**
 * Converts a chat-completions message to an {@link LlmResponse}.
 */
export function messageToGenerateContentResponse(
  message: ChatCompletionResponseMessage,
  isPartial = false,
): LlmResponse {
  const parts: Part[] = [];
  if (message.content) {
    parts.push({text: message.content});
  }
  for (const toolCall of message.tool_calls ?? []) {
    if (toolCall.type === 'function') {
      parts.push({
        functionCall: {
          id: toolCall.id,
          name: toolCall.function.name,
          args: JSON.parse(toolCall.function.arguments || '{}'),
        },
      });
    }
  }
  return {content: {role: 'model', parts}, partial: isPartial};
}

/**
 * Converts a complete chat-completions response to an {@link LlmResponse}.
 *
 * @throws Error if the response has no message.
 */
export function modelResponseToGenerateContentResponse(
  response: ModelResponse,
): LlmResponse {
  const message = response.choices?.[0]?.message;
  if (!message) {
    throw new Error('No message in response');
  }
  return messageToGenerateContentResponse(message);
}

/**
 * Converts an {@link LlmRequest} to chat-completions messages and tools.
 */
export function getCompletionInputs(llmRequest: LlmRequest): {
  messages: ChatCompletionMessage[];
  tools?: ChatCompletionTool[];
} {
  const messages = (llmRequest.contents ?? []).map(contentToMessageParam);

  const systemInstruction = llmRequest.config?.systemInstruction;
  if (systemInstruction) {
    messages.unshift({
      role: 'developer',
      content: contentUnionToText(systemInstruction),
    });
  }

  const firstTool = llmRequest.config?.tools?.[0];
  const tools =
    firstTool &&
    'functionDeclarations' in firstTool &&
    firstTool.functionDeclarations
      ? firstTool.functionDeclarations.map(functionDeclarationToToolParam)
      : undefined;

  return {messages, tools};
}

function withoutReservedArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!RESERVED_COMPLETION_ARGS.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * A model that talks to any OpenAI-compatible chat-completions backend, such
 * as a LiteLLM proxy, through a {@link LiteLlmClient}.
 *
 * Streaming responses yield each text chunk as a partial response, then a
 * final aggregated text response when the model stops, and one function-call
 * response per completed tool call.
 */
export class LiteLlm extends BaseLlm {
  private readonly llmClient: LiteLlmClient;
  private readonly additionalArgs: Record<string, unknown>;

  constructor({model, llmClient, additionalArgs = {}}: LiteLlmParams) {
    super({model});
    this.llmClient = llmClient;
    this.additionalArgs = withoutReservedArgs(additionalArgs);
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    logger.debug(
      `Sending LiteLlm request with ${llmRequest.contents?.length ?? 0} contents`,
    );
    const {messages, tools} = getCompletionInputs(llmRequest);
    const request: CompletionRequest = {
      model: this.model,
      messages,
      tools,
      additionalArgs: this.additionalArgs,
    };

    if (!stream) {
      const response = await this.llmClient.acompletion(request);
      yield modelResponseToGenerateContentResponse(response);
      return;
    }

    let text = '';
    let functionName = '';
    let functionArgs = '';
    let functionId: string | undefined;

    for await (const part of this.llmClient.completion({
      ...request,
      stream: true,
    })) {
      for (const [chunk, finishReason] of modelResponseToChunk(part)) {
        if (chunk) {
          if (isTextChunk(chunk)) {
            text += chunk.text;
            yield messageToGenerateContentResponse(
              {role: 'assistant', content: chunk.text},
              true,
            );
          } else {
            functionName += chunk.name ?? '';
            functionArgs += chunk.args ?? '';
            functionId = chunk.id || functionId;
          }
        }

        if (finishReason === 'tool_calls' && functionId) {
          yield messageToGenerateContentResponse({
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                type: 'function',
                id: functionId,
                function: {name: functionName, arguments: functionArgs},
              },
            ],
          });
          functionName = '';
          functionArgs = '';
          functionId = undefined;
        } else if (finishReason === 'stop' && text) {
          yield messageToGenerateContentResponse({
            role: 'assistant',
            content: text,
          });
          text = '';
        }
      }
    }
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error('Live connection is not supported for LiteLlm.');
  }
}
