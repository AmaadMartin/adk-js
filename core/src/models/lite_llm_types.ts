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

import {JsonObject} from '../utils/json_utils.js';

/**
 * The roles an OpenAI-compatible chat message can carry.
 *
 * `tool_responses` is the Gemma 4 spelling of `tool`. Its chat template does
 * not recognise a tool result under any other role.
 */
export type MessageRole =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'tool_responses';

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

/**
 * An Anthropic thinking block. Claude reads these both as a top-level
 * `thinking_blocks` array and as a block inside a message content list. The
 * signature is required for a block to survive into a multi-turn history.
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

/** One block of a multipart message content. */
export type ContentObject =
  | TextContentObject
  | ImageContentObject
  | VideoContentObject
  | AudioContentObject
  | FileContentObject
  | ThinkingBlock;

/** A message content: a bare string, or a list of typed blocks. */
export type MessageContent = string | ContentObject[];

/** The function named by a tool call, and its serialized arguments. */
export interface ToolCallFunction {
  name?: string;
  arguments?: string;
  /** Provider extensions, which is one place a thought signature travels. */
  provider_specific_fields?: JsonObject;
}

/** A tool call requested by the model, or a streamed fragment of one. */
export interface ToolCall {
  type?: 'function';
  id?: string;
  index?: number;
  function?: ToolCallFunction;
  /** The OpenAI-compatible channel for provider extensions. */
  extra_content?: JsonObject;
  /** Provider extensions, which is one place a thought signature travels. */
  provider_specific_fields?: JsonObject;
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

/**
 * The `usage` block as it arrives. Some providers serialize it to a JSON
 * string instead of sending an object, so both shapes are declared.
 */
export type RawUsage = Usage | string;

/** A non-streaming chat-completions response. */
export interface ModelResponse {
  model?: string;
  choices?: Choice[];
  usage?: RawUsage;
  vertex_ai_grounding_metadata?: unknown;
}

/** One chunk of a streamed chat-completions response. */
export interface ModelResponseStream {
  model?: string;
  choices?: StreamChoice[];
  usage?: RawUsage;
  vertex_ai_grounding_metadata?: unknown;
}

/** The value of the `tool_choice` request field ADK sends. */
export type ToolChoice = 'required' | 'none';

/**
 * How long a provider should keep a marked prefix. `ephemeral` is the
 * short-lived default; `1h` asks for the longest cache a provider offers.
 */
export interface CacheControl {
  type: 'ephemeral';
  ttl?: '1h';
}

/**
 * One place in the request that LiteLLM marks as the end of a cacheable
 * prefix.
 *
 * LiteLLM applies these itself and lets each provider decide what to do with
 * them: a provider that caches by marked prefix honors them, and a provider
 * that caches automatically has them dropped before the request leaves.
 */
export interface CacheControlInjectionPoint {
  location: 'message';
  /** Marks the message with this role. Mutually exclusive with `index`. */
  role?: string;
  /** Marks the message at this position. `-1` is the last message. */
  index?: number;
  control: CacheControl;
}

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
  /**
   * Headers LiteLLM adds to the call it makes to the provider.
   *
   * This is a request parameter, not a header of the request that carries it.
   * A LiteLLM Proxy does not forward the headers a client sent it, so this is
   * the only channel that reaches the provider. Use `extra_headers` for the
   * headers of the hop to the endpoint itself.
   */
  headers?: Record<string, string>;
  extra_headers?: Record<string, string>;
  extra_body?: Record<string, unknown>;
  cache_control_injection_points?: CacheControlInjectionPoint[];
  /** Request timeout in seconds, matching LiteLLM rather than `HttpOptions`. */
  timeout?: number;
  num_retries?: number;
}
