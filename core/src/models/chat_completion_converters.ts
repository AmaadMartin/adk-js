/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  createPartFromText,
  FunctionDeclaration,
  Part,
} from '@google/genai';

import {genaiSchemaToJsonSchema} from '../utils/genai_schema_to_json.js';

import {extractSystemInstruction} from './interactions_utils.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/** Role of a chat-completions message. */
export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';

/** A text block inside a multi-part message content. */
export interface ChatTextObject {
  type: 'text';
  text: string;
}

/** An image block inside a multi-part message content. */
export interface ChatImageObject {
  type: 'image_url';
  image_url: {url: string};
}

/** A video block inside a multi-part message content. */
export interface ChatVideoObject {
  type: 'video_url';
  video_url: {url: string};
}

/** One block of a multi-part message content. */
export type ChatContentObject =
  | ChatTextObject
  | ChatImageObject
  | ChatVideoObject;

/** A tool call requested by the model. */
export interface ChatToolCall {
  type: 'function';
  id?: string;
  function: {name?: string; arguments?: string};
}

/** One chat-completions message, on the request or the response side. */
export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentObject[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

/** A function the model may call, in chat-completions form. */
export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/** One `choices[]` entry; `message` is buffered, `delta` is streamed. */
export interface ChatChoice {
  message?: ChatMessage;
  delta?: ChatMessage;
  finish_reason?: string | null;
}

/** A chat-completions response, buffered or one streamed chunk of one. */
export interface ChatCompletionResponse {
  choices?: ChatChoice[];
}

/** A piece of a streamed choice: either text or part of a tool call. */
export type StreamPiece =
  | {kind: 'text'; text: string}
  | {kind: 'function'; id?: string; name?: string; args?: string};

/**
 * Converts a genai content role to a chat-completions role.
 */
export function toChatRole(role?: string): 'user' | 'assistant' {
  return role === 'model' || role === 'assistant' ? 'assistant' : 'user';
}

/**
 * Serializes a value to JSON, falling back to its string form when it is not
 * JSON-serializable (a circular reference, a `BigInt`, `undefined`).
 */
export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (_e: unknown) {
    return String(value);
  }
}

/**
 * Converts genai parts to chat-completions message content.
 *
 * A lone text part becomes a bare string, which every OpenAI-compatible server
 * accepts; anything else becomes a block list. An empty result is `null`, not
 * an empty array, because an empty array is not valid message content.
 */
export function partsToMessageContent(
  parts: Part[],
): string | ChatContentObject[] | null {
  const blocks: ChatContentObject[] = [];

  for (const part of parts) {
    if (part.text) {
      if (parts.length === 1) {
        return part.text;
      }
      blocks.push({type: 'text', text: part.text});
    } else if (part.inlineData?.data && part.inlineData.mimeType) {
      blocks.push(
        inlineDataToBlock(part.inlineData.mimeType, part.inlineData.data),
      );
    }
  }

  return blocks.length > 0 ? blocks : null;
}

/**
 * Wraps inline media in the block the chat-completions wire format expects.
 *
 * `data` is already base64 in `@google/genai` for JavaScript, so it is
 * embedded verbatim rather than encoded again.
 */
function inlineDataToBlock(mimeType: string, data: string): ChatContentObject {
  const url = `data:${mimeType};base64,${data}`;
  switch (mimeType.split('/')[0]) {
    case 'image':
      return {type: 'image_url', image_url: {url}};
    case 'video':
      return {type: 'video_url', video_url: {url}};
    default:
      throw new Error(
        `Unsupported inline data MIME type: ${mimeType}. Only image and ` +
          `video parts can be sent to a chat-completions endpoint.`,
      );
  }
}

/**
 * Converts a genai `Content` to a chat-completions message.
 */
export function contentToMessage(content: Content): ChatMessage {
  const parts = content.parts ?? [];
  const functionResponse = parts[0]?.functionResponse;
  if (functionResponse) {
    return {
      role: 'tool',
      tool_call_id: functionResponse.id,
      content: safeJsonStringify(functionResponse.response),
    };
  }

  const role = toChatRole(content.role);
  const messageContent = partsToMessageContent(parts);
  if (role === 'user') {
    return {role, content: messageContent};
  }

  const toolCalls: ChatToolCall[] = [];
  for (const part of parts) {
    if (part.functionCall) {
      toolCalls.push({
        type: 'function',
        id: part.functionCall.id,
        function: {
          name: part.functionCall.name,
          arguments: safeJsonStringify(part.functionCall.args ?? {}),
        },
      });
    }
  }

  return {
    role,
    content: messageContent,
    ...(toolCalls.length > 0 && {tool_calls: toolCalls}),
  };
}

/**
 * Converts a genai function declaration to a chat-completions tool.
 */
export function functionDeclarationToTool(
  declaration: FunctionDeclaration,
): ChatTool {
  const properties: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(
    declaration.parameters?.properties ?? {},
  )) {
    properties[name] = genaiSchemaToJsonSchema(schema);
  }

  const required = declaration.parameters?.required;

  return {
    type: 'function',
    function: {
      name: declaration.name ?? '',
      description: declaration.description ?? '',
      parameters: {
        type: 'object',
        properties,
        ...(required?.length && {required}),
      },
    },
  };
}

/**
 * Reads the function declarations of the first declarative tool in a request,
 * which is the only entry a chat-completions endpoint is given.
 */
export function requestFunctionDeclarations(
  llmRequest: LlmRequest,
): FunctionDeclaration[] {
  const tool = llmRequest.config?.tools?.[0];
  if (tool && 'functionDeclarations' in tool) {
    return tool.functionDeclarations ?? [];
  }
  return [];
}

/**
 * Converts a request's system instruction and contents to chat-completions
 * messages, system instruction first.
 */
export function requestToMessages(llmRequest: LlmRequest): ChatMessage[] {
  const messages = llmRequest.contents.map(contentToMessage);
  const systemInstruction = extractSystemInstruction(llmRequest.config ?? {});
  if (systemInstruction) {
    messages.unshift({role: 'system', content: systemInstruction});
  }
  return messages;
}

/**
 * Converts a request's function declarations to chat-completions tools, or
 * `undefined` when it declares none.
 */
export function requestToTools(llmRequest: LlmRequest): ChatTool[] | undefined {
  const declarations = requestFunctionDeclarations(llmRequest);
  return declarations.length > 0
    ? declarations.map(functionDeclarationToTool)
    : undefined;
}

/**
 * Converts a chat-completions message to an `LlmResponse`.
 *
 * Text comes first, then one function-call part per tool call, because callers
 * read `parts[0]` as the model's prose.
 */
export function messageToLlmResponse(
  message: ChatMessage,
  isPartial = false,
): LlmResponse {
  const parts: Part[] = [];

  if (typeof message.content === 'string' && message.content) {
    parts.push(createPartFromText(message.content));
  }

  for (const toolCall of message.tool_calls ?? []) {
    if (toolCall.type === 'function') {
      parts.push({
        functionCall: {
          id: toolCall.id,
          name: toolCall.function.name,
          args: JSON.parse(toolCall.function.arguments || '{}') as Record<
            string,
            unknown
          >,
        },
      });
    }
  }

  return {content: {role: 'model', parts}, partial: isPartial};
}

/**
 * Renames the finish reasons that differ between compatible servers.
 *
 * Anthropic-compatible endpoints report a tool call as `tool_use`; OpenAI
 * reports it as `tool_calls`, which is what the streaming aggregator branches
 * on.
 */
export function normalizeFinishReason(
  reason?: string | null,
): string | undefined {
  if (reason === 'tool_use') {
    return 'tool_calls';
  }
  return reason ?? undefined;
}

/**
 * Splits one response, buffered or streamed, into its pieces.
 *
 * Each yielded tuple pairs a piece with the choice's finish reason. A choice
 * that carries only a finish reason still yields one tuple, so the caller sees
 * the end of the turn.
 */
export function* chunkPieces(
  chunk: ChatCompletionResponse,
): Generator<[StreamPiece | undefined, string | undefined]> {
  const choice = chunk.choices?.[0];
  const message = choice?.message ?? choice?.delta;
  if (!choice || !message) {
    yield [undefined, undefined];
    return;
  }

  const finishReason = normalizeFinishReason(choice.finish_reason);
  const text = typeof message.content === 'string' ? message.content : '';
  const toolCalls = message.tool_calls ?? [];

  if (text) {
    yield [{kind: 'text', text}, finishReason];
  }

  for (const toolCall of toolCalls) {
    if (toolCall.type === 'function') {
      yield [
        {
          kind: 'function',
          id: toolCall.id,
          name: toolCall.function.name,
          args: toolCall.function.arguments,
        },
        finishReason,
      ];
    }
  }

  if (finishReason && !text && toolCalls.length === 0) {
    yield [undefined, finishReason];
  }
}
