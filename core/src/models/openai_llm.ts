/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenAI Chat Completions integration for GPT models.
 *
 * Ported from adk-python `src/google/adk/labs/openai/_openai_llm.py`.
 */

import type {OpenAI} from 'openai';

import {loadOptionalPeer} from '../utils/optional_peer.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';
import {
  buildCreateParams,
  completionToLlmResponse,
  streamToLlmResponses,
} from './openai_converters.js';

/** The model used when the caller names none. */
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

/** The generated-token ceiling used when the request sets none. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * The Chat Completions surface {@link OpenAILlm} calls.
 *
 * Only the two overloads ADK uses are named, so a test double or an
 * OpenAI-compatible client can stand in for the SDK client.
 */
export interface OpenAICompletions {
  create(
    body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    options?: {signal?: AbortSignal},
  ): Promise<OpenAI.Chat.ChatCompletion>;
  create(
    body: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
    options?: {signal?: AbortSignal},
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>;
}

/** The client surface {@link OpenAILlm} calls. */
export interface OpenAIClient {
  readonly chat: {readonly completions: OpenAICompletions};
}

/** Parameters for constructing an {@link OpenAILlm}. */
export interface OpenAILlmParams {
  /** The OpenAI model to call. Defaults to `gpt-4o`. */
  model?: string;
  /** Upper bound on generated tokens when the request sets none. */
  maxTokens?: number;
  /**
   * A pre-configured client. Supply one to reach an OpenAI-compatible host, or
   * to set an API key, organization, timeout or retry policy explicitly.
   * Without it, the SDK builds a default client that reads its configuration
   * from the environment.
   */
  client?: OpenAIClient;
}

/**
 * A `BaseLlm` that calls the OpenAI Chat Completions API.
 *
 * The `openai` package is an optional peer dependency, loaded on first use.
 *
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'assistant',
 *   model: new OpenAILlm({model: 'gpt-4o'}),
 * });
 * ```
 */
export class OpenAILlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    'gpt-.*',
    'o\\d+-.*',
  ];

  private readonly maxTokens: number;
  private clientPromise?: Promise<OpenAIClient>;

  constructor(params: OpenAILlmParams = {}) {
    super({model: params.model ?? DEFAULT_OPENAI_MODEL});
    this.maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.clientPromise = params.client && Promise.resolve(params.client);
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const completions = (await this.resolveClient()).chat.completions;
    const params = buildCreateParams(llmRequest, this.model, this.maxTokens);
    const options = {signal: abortSignal};

    if (!stream) {
      yield completionToLlmResponse(await completions.create(params, options));
      return;
    }
    yield* streamToLlmResponses(
      await completions.create({...params, stream: true}, options),
    );
  }

  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(
      new Error(`Live connection is not supported for ${this.model}.`),
    );
  }

  /**
   * Returns the client, building the default one at most once.
   *
   * The promise is memoised rather than the client, so that concurrent
   * requests share a single load of the SDK and a single credential
   * resolution.
   */
  private resolveClient(): Promise<OpenAIClient> {
    return (this.clientPromise ??= createDefaultClient());
  }
}

/** Loads the SDK and builds a client from the environment. */
async function createDefaultClient(): Promise<OpenAIClient> {
  const {OpenAI} = await loadOptionalPeer(
    {
      packageName: 'openai',
      feature: 'OpenAILlm (GPT models via the OpenAI API)',
    },
    () => import('openai'),
  );
  return new OpenAI();
}
