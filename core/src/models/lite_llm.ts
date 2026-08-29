/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';

import {isBrowser} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {readSseData} from '../utils/sse_utils.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {
  ChatCompletionResponse,
  chunkPieces,
  messageToLlmResponse,
  requestFunctionDeclarations,
  requestToMessages,
  requestToTools,
} from './chat_completion_converters.js';
import {extractSystemInstruction} from './interactions_utils.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

const API_BASE_ENV_VARIABLE_NAME = 'LITELLM_API_BASE';
const API_KEY_ENV_VARIABLE_NAME = 'LITELLM_API_KEY';

/** Path appended to the configured base URL. */
const CHAT_COMPLETIONS_PATH = '/chat/completions';

/**
 * Request body keys the class owns. They are stripped from `additionalArgs`,
 * so a caller cannot redirect the model or replace the conversation.
 */
const RESERVED_BODY_KEYS = ['model', 'messages', 'tools', 'stream'];

/** Cap on how much of a failed response body reaches the thrown error. */
const MAX_ERROR_BODY_LENGTH = 2048;

const LOG_SEPARATOR =
  '-----------------------------------------------------------';

/** Parameters for constructing a {@link LiteLlm}. */
export interface LiteLlmParams {
  /**
   * Model name, sent verbatim as the request `model`. A LiteLLM-style
   * `provider/model` string such as `anthropic/claude-sonnet-4` passes through
   * untouched, because the proxy resolves it.
   */
  model: string;
  /**
   * Base URL of the OpenAI-compatible server, for example
   * `http://localhost:4000/v1`. Falls back to the `LITELLM_API_BASE`
   * environment variable outside a browser. The constructor throws when
   * neither is set.
   */
  apiBase?: string;
  /**
   * API key, sent as `Authorization: Bearer <apiKey>`. Falls back to the
   * `LITELLM_API_KEY` environment variable outside a browser. A local Ollama
   * or vLLM server needs no key, so absent is legal.
   */
  apiKey?: string;
  /**
   * Extra headers merged into every request, beneath `Content-Type` and
   * `Authorization`.
   */
  headers?: Record<string, string>;
  /**
   * Extra request body fields, for example `temperature` or `max_tokens`. The
   * class-owned keys `model`, `messages`, `tools` and `stream` are dropped.
   */
  additionalArgs?: Record<string, unknown>;
}

/**
 * A `BaseLlm` that speaks the OpenAI Chat Completions wire protocol, so an
 * `LlmAgent` can run on any OpenAI-compatible endpoint: a LiteLLM proxy,
 * OpenAI, Ollama, vLLM, LM Studio, Together, Groq or Fireworks.
 *
 * Provider routing lives in the endpoint, not here. Python's `LiteLlm`
 * delegates to the `litellm` package for the provider table and the
 * per-provider credential lookup; there is no such library for JavaScript, so
 * this class takes one base URL and one key.
 *
 * A base URL is always required, so instances are constructed explicitly and
 * handed to an agent. `LiteLlm` is never registered in `LLMRegistry`, and a
 * bare model name never resolves to it.
 *
 * @example
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'assistant',
 *   model: new LiteLlm({
 *     model: 'anthropic/claude-sonnet-4',
 *     apiBase: 'http://localhost:4000/v1',
 *     apiKey: process.env['LITELLM_MASTER_KEY'],
 *   }),
 * });
 * ```
 */
export class LiteLlm extends BaseLlm {
  /** Empty: a model name alone must never resolve to this class. */
  static override readonly supportedModels: Array<string | RegExp> = [];

  private readonly url: string;
  private readonly apiKey?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly additionalArgs: Record<string, unknown>;

  constructor({
    model,
    apiBase,
    apiKey,
    headers,
    additionalArgs,
  }: LiteLlmParams) {
    super({model});

    const base = apiBase ?? readEnv(API_BASE_ENV_VARIABLE_NAME);
    if (!base) {
      throw new Error(
        `API base URL must be provided via the apiBase option or the ` +
          `${API_BASE_ENV_VARIABLE_NAME} environment variable.`,
      );
    }

    this.url = toChatCompletionsUrl(base);
    this.apiKey = apiKey ?? readEnv(API_KEY_ENV_VARIABLE_NAME);
    this.extraHeaders = headers ?? {};
    this.additionalArgs = withoutReservedKeys(additionalArgs ?? {});
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    logger.debug(buildRequestLog(llmRequest));

    const tools = requestToTools(llmRequest);
    const body = {
      model: this.model,
      messages: requestToMessages(llmRequest),
      ...(tools && {tools}),
      ...this.additionalArgs,
      ...(stream && {stream: true}),
    };

    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal: abortSignal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `LiteLlm request to ${this.model} failed with status ` +
          `${response.status}: ${text.slice(0, MAX_ERROR_BODY_LENGTH)}`,
      );
    }

    if (stream) {
      yield* streamResponses(response);
      return;
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw new Error('No message in response');
    }
    yield messageToLlmResponse(message);
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(`Live connection is not supported for ${this.model}.`);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.extraHeaders,
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}

/**
 * Reads an environment variable, or `undefined` in a browser where there is no
 * process environment.
 */
function readEnv(name: string): string | undefined {
  return isBrowser() ? undefined : process.env[name];
}

/**
 * Resolves the chat-completions endpoint from a base URL, leaving a URL that
 * already names the endpoint alone.
 */
function toChatCompletionsUrl(apiBase: string): string {
  const trimmed = apiBase.replace(/\/+$/, '');
  return trimmed.endsWith(CHAT_COMPLETIONS_PATH)
    ? trimmed
    : `${trimmed}${CHAT_COMPLETIONS_PATH}`;
}

/** Copies extra request arguments, minus the keys the class owns. */
function withoutReservedKeys(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const copy = {...args};
  for (const key of RESERVED_BODY_KEYS) {
    delete copy[key];
  }
  return copy;
}

/**
 * Aggregates a streamed response into `LlmResponse`s.
 *
 * Text is emitted twice by design: once per chunk as a partial response, and
 * once more in full when the turn stops. Tool-call name and argument fragments
 * accumulate until the finish reason reports the call, then the accumulator
 * resets so a second call in the same stream starts clean.
 */
async function* streamResponses(
  response: Response,
): AsyncGenerator<LlmResponse, void> {
  if (!response.body) {
    throw new Error('Streaming response has no body.');
  }

  let text = '';
  let functionName = '';
  let functionArgs = '';
  let functionId: string | undefined;

  for await (const payload of readSseData(response.body)) {
    const chunk = JSON.parse(payload) as ChatCompletionResponse;

    for (const [piece, finishReason] of chunkPieces(chunk)) {
      if (piece?.kind === 'function') {
        functionName += piece.name ?? '';
        functionArgs += piece.args ?? '';
        functionId = piece.id ?? functionId;
      } else if (piece?.kind === 'text') {
        text += piece.text;
        yield messageToLlmResponse(
          {role: 'assistant', content: piece.text},
          true,
        );
      }

      if (finishReason === 'tool_calls' && functionId) {
        yield messageToLlmResponse({
          role: 'assistant',
          content: null,
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
        yield messageToLlmResponse({role: 'assistant', content: text});
        text = '';
      }
    }
  }
}

/**
 * Renders a request for the debug log.
 *
 * Inline media bytes are dropped, so a log line stays readable and no image
 * payload is written to disk. Headers are never logged, which keeps the API
 * key out of the log.
 */
function buildRequestLog(request: LlmRequest): string {
  const functionLogs = requestFunctionDeclarations(request).map((declaration) =>
    JSON.stringify(declaration),
  );
  const contentLogs = request.contents.map((content) =>
    JSON.stringify(withoutInlineBytes(content)),
  );

  return [
    'LLM Request:',
    LOG_SEPARATOR,
    'System Instruction:',
    extractSystemInstruction(request.config ?? {}) ?? '',
    LOG_SEPARATOR,
    'Contents:',
    ...contentLogs,
    LOG_SEPARATOR,
    'Functions:',
    ...functionLogs,
    LOG_SEPARATOR,
  ].join('\n');
}

/** Returns the content with every inline media payload removed. */
function withoutInlineBytes(content: Content): Content {
  if (!content.parts) {
    return content;
  }
  return {...content, parts: content.parts.map(withoutPartInlineBytes)};
}

/** Returns the part with its inline media payload removed. */
function withoutPartInlineBytes(part: Part): Part {
  if (!part.inlineData) {
    return part;
  }
  return {...part, inlineData: {...part.inlineData, data: undefined}};
}
