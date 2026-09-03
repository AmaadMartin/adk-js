/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isBrowser} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

import {
  CompletionArgs,
  ModelResponse,
  ModelResponseStream,
} from './lite_llm_types.js';

/** Environment variable holding the endpoint base URL. */
export const LITELLM_API_BASE_ENV_VARIABLE_NAME = 'LITELLM_API_BASE';

/** Environment variable holding the endpoint API key. */
export const LITELLM_API_KEY_ENV_VARIABLE_NAME = 'LITELLM_API_KEY';

/** The path appended to the base URL when it does not already end in it. */
const CHAT_COMPLETIONS_PATH = '/chat/completions';

/** How much of an error response body reaches the thrown error. */
const MAX_ERROR_BODY_LENGTH = 2048;

/** The frame that ends a server-sent event stream. */
const SSE_DONE = '[DONE]';

/** Separator between server-sent event frames, with or without carriage returns. */
const SSE_FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * The transport {@link LiteLlm} sends its requests through.
 *
 * This is the seam a test or a caller replaces to route requests somewhere
 * else: an SDK, a signed-request layer, or a fake that returns canned
 * responses.
 */
export interface LiteLlmClient {
  /** Sends one request and resolves with the whole response. */
  completion(
    args: CompletionArgs,
    abortSignal?: AbortSignal,
  ): Promise<ModelResponse>;

  /** Sends one request and resolves with the stream of response chunks. */
  streamCompletion(
    args: CompletionArgs,
    abortSignal?: AbortSignal,
  ): Promise<AsyncIterable<ModelResponseStream>>;
}

/** Constructor parameters for {@link FetchLiteLlmClient}. */
export interface FetchLiteLlmClientParams {
  /**
   * The endpoint base URL, for example `http://localhost:4000/v1`. Falls back
   * to the `LITELLM_API_BASE` environment variable outside a browser.
   */
  apiBase?: string;
  /**
   * The API key sent as a bearer token. Falls back to the `LITELLM_API_KEY`
   * environment variable outside a browser. A local Ollama or vLLM server
   * needs none.
   */
  apiKey?: string;
  /** Extra HTTP headers, sent beneath the ones this client sets itself. */
  headers?: Record<string, string>;
}

/**
 * The built-in {@link LiteLlmClient}: a `fetch` POST to an OpenAI-compatible
 * `/chat/completions` endpoint.
 *
 * Provider routing lives in that endpoint, so a LiteLLM Proxy deployment
 * reaches any model LiteLLM supports. `extra_headers` becomes HTTP headers and
 * `extra_body` is merged into the request body; every other argument is sent
 * as a request parameter, which is how a LiteLLM Proxy reads `timeout` and
 * `num_retries`.
 */
export class FetchLiteLlmClient implements LiteLlmClient {
  private readonly url: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;

  constructor({apiBase, apiKey, headers}: FetchLiteLlmClientParams = {}) {
    const base = apiBase || readEnv(LITELLM_API_BASE_ENV_VARIABLE_NAME);
    if (!base) {
      throw new Error(
        'A base URL is required: pass `apiBase` or set the ' +
          `${LITELLM_API_BASE_ENV_VARIABLE_NAME} environment variable.`,
      );
    }
    const trimmed = base.replace(/\/+$/, '');
    this.url = trimmed.endsWith(CHAT_COMPLETIONS_PATH)
      ? trimmed
      : `${trimmed}${CHAT_COMPLETIONS_PATH}`;
    this.apiKey = apiKey || readEnv(LITELLM_API_KEY_ENV_VARIABLE_NAME);
    this.headers = headers ?? {};
  }

  async completion(
    args: CompletionArgs,
    abortSignal?: AbortSignal,
  ): Promise<ModelResponse> {
    const response = await this.post(args, abortSignal);
    return response.json() as Promise<ModelResponse>;
  }

  async streamCompletion(
    args: CompletionArgs,
    abortSignal?: AbortSignal,
  ): Promise<AsyncIterable<ModelResponseStream>> {
    const response = await this.post(args, abortSignal);
    const body = response.body;
    if (!body) {
      throw new Error(
        `LiteLlm streaming request to model ${args.model} returned no body.`,
      );
    }
    return readServerSentEvents(body);
  }

  /** Sends the request and rejects when the endpoint returns an error. */
  private async post(
    args: CompletionArgs,
    abortSignal?: AbortSignal,
  ): Promise<Response> {
    const {extra_headers: extraHeaders, extra_body: extraBody, ...rest} = args;
    const body = {...rest, ...extraBody};
    const headers: Record<string, string> = {
      ...this.headers,
      ...extraHeaders,
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    logger.debug(`LiteLlm: POST ${this.url} for model ${args.model}`);
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `LiteLlm request to model ${args.model} failed with status ` +
          `${response.status}: ${text.slice(0, MAX_ERROR_BODY_LENGTH)}`,
      );
    }
    return response;
  }
}

/** Reads an environment variable, returning undefined in a browser. */
function readEnv(name: string): string | undefined {
  return isBrowser() ? undefined : process.env[name];
}

/** Yields the JSON payload of every server-sent event frame in a body. */
async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ModelResponseStream> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {stream: true});
      for (;;) {
        const separator = SSE_FRAME_SEPARATOR.exec(buffer);
        if (!separator) {
          break;
        }
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const chunk = parseServerSentEventFrame(frame);
        if (chunk === SSE_DONE) {
          return;
        }
        if (chunk) {
          yield chunk;
        }
      }
    }
    const trailing = parseServerSentEventFrame(buffer);
    if (trailing && trailing !== SSE_DONE) {
      yield trailing;
    }
  } finally {
    // Cancels the body on the error and early-return paths as well as the
    // happy one, so an abandoned stream does not hold the connection open.
    await reader.cancel();
  }
}

/**
 * Parses one frame into a response chunk.
 *
 * @returns The chunk, the `[DONE]` sentinel, or undefined for a frame that
 *     carries no data.
 */
function parseServerSentEventFrame(
  frame: string,
): ModelResponseStream | typeof SSE_DONE | undefined {
  const payloads: string[] = [];
  for (const line of frame.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      payloads.push(trimmed.slice('data:'.length).trim());
    }
  }
  const data = payloads.join('');
  if (!data) {
    return undefined;
  }
  if (data === SSE_DONE) {
    return SSE_DONE;
  }
  return JSON.parse(data) as ModelResponseStream;
}
