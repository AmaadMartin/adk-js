/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wire-format types for the OpenAI-compatible chat-completions protocol that
 * {@link LiteLlm} speaks.
 *
 * Property names here are the wire contract and stay snake_case even though the
 * rest of the codebase is camelCase. Renaming them would change the bytes on
 * the wire.
 */

/** Any value that survives a JSON round trip. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

/** A JSON object, used for payloads whose shape the provider defines. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** The roles an OpenAI-compatible chat message can carry. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** A plain-text block inside a multipart message content. */
export interface TextContentObject {
  type: 'text';
  text: string;
}

/** An image block, carrying either a data URI or an HTTP URL. */
export interface ImageContentObject {
  type: 'image_url';
  image_url: {url: string};
}

/** A video block, carrying either a data URI or an HTTP URL. */
export interface VideoContentObject {
  type: 'video_url';
  video_url: {url: string};
}

/**
 * An audio block. OpenAI has no `audio_url` content type, so audio always
 * travels as base64 data plus a format string.
 */
export interface AudioContentObject {
  type: 'input_audio';
  input_audio: {data: string; format: string};
}

/** The payload of a {@link FileContentObject}. */
export interface FileUrlObject {
  /** An already-uploaded file id, or a URI the provider can resolve. */
  file_id?: string;
  /** A `data:` URI carrying the file inline. */
  file_data?: string;
  /** The MIME type of the file. */
  format?: string;
}

/** A document block. */
export interface FileContentObject {
  type: 'file';
  file: FileUrlObject;
}

/** One block of a multipart message content. */
export type ContentObject =
  | TextContentObject
  | ImageContentObject
  | VideoContentObject
  | AudioContentObject
  | FileContentObject;

/** A message content: a bare string, or a list of typed blocks. */
export type MessageContent = string | ContentObject[];

/** The function named by a tool call, and its serialized arguments. */
export interface ToolCallFunction {
  name?: string;
  arguments?: string;
}

/** A tool call requested by the model, or a streamed fragment of one. */
export interface ToolCall {
  type?: 'function';
  id?: string;
  index?: number;
  function?: ToolCallFunction;
}

/**
 * A chat message, in both directions.
 *
 * The reasoning fields are provider extensions and have no single shape:
 * `thinking_blocks` is an Anthropic list, `reasoning_content` is the LiteLLM
 * standard field, and `reasoning` is what LM Studio and vLLM emit.
 */
export interface ChatMessage {
  role: MessageRole;
  content?: MessageContent | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: unknown;
  reasoning?: unknown;
  thinking_blocks?: unknown;
}

/** A function tool declaration. */
export interface ToolParam {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonObject;
  };
}

/**
 * An entry of the request's `tools` array: either a function declaration or a
 * native/built-in tool forwarded to the provider verbatim.
 */
export type ToolSpec = ToolParam | JsonObject;

/** The `prompt_tokens_details` breakdown, when the provider sends one. */
export interface PromptTokensDetails {
  cached_tokens?: number;
}

/** The `completion_tokens_details` breakdown, when the provider sends one. */
export interface CompletionTokensDetails {
  reasoning_tokens?: number;
}

/**
 * Token accounting. Providers disagree on where cached-token counts live, so
 * every shape LiteLLM normalizes to is declared here.
 */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: PromptTokensDetails | PromptTokensDetails[];
  completion_tokens_details?: CompletionTokensDetails;
  cached_prompt_tokens?: number;
  cached_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_write_input_tokens?: number;
}

/** One choice of a non-streaming response. */
export interface Choice {
  index?: number;
  message?: ChatMessage;
  finish_reason?: string | null;
}

/** One choice of a streamed response chunk. */
export interface StreamChoice {
  index?: number;
  delta?: ChatMessage;
  finish_reason?: string | null;
}

/** A non-streaming chat-completions response. */
export interface ModelResponse {
  model?: string;
  choices?: Choice[];
  usage?: Usage;
  vertex_ai_grounding_metadata?: unknown;
}

/** One chunk of a streamed chat-completions response. */
export interface ModelResponseStream {
  model?: string;
  choices?: StreamChoice[];
  usage?: Usage;
  vertex_ai_grounding_metadata?: unknown;
}

/** The value of the `tool_choice` request field ADK sends. */
export type ToolChoice = 'required' | 'none';

/** The generation parameters, under the names the wire protocol uses. */
export interface GenerationParams {
  temperature?: number;
  max_completion_tokens?: number;
  top_p?: number;
  top_k?: number;
  stop?: string[];
  presence_penalty?: number;
  frequency_penalty?: number;
}

/**
 * The chat-completions request body.
 *
 * A caller's `additionalArgs` are merged over these fields as extra top-level
 * properties, so the declared set is not exhaustive of what reaches the wire.
 */
export interface CompletionArgs extends GenerationParams {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  response_format?: JsonObject;
  tool_choice?: ToolChoice;
  stream?: boolean;
  stream_options?: {include_usage: boolean};
  extra_headers?: Record<string, string>;
  extra_body?: Record<string, unknown>;
  /** Request timeout in seconds, matching LiteLLM rather than `HttpOptions`. */
  timeout?: number;
  num_retries?: number;
}
