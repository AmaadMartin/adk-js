/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseLlm, BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import OpenAI from 'openai';
import type {
  ResponseIncludable,
  ServiceTier,
} from 'openai/resources/responses/responses';
import type {Reasoning} from 'openai/resources/shared';
import {
  buildResponsesRequest,
  ResponsesRequestBody,
} from './openai_responses_request.js';
import {responseToLlmResponse} from './openai_responses_response.js';
import {StreamAccumulator} from './openai_responses_stream.js';

/** The model the Responses API is driven with when none is given. */
const DEFAULT_MODEL = 'gpt-5';

/** The Azure path that exposes the OpenAI-compatible Responses endpoint. */
const AZURE_OPENAI_V1_PATH = '/openai/v1/';

/** Settings shared by both Responses providers. */
export interface OpenAiResponsesLlmParams {
  /** The model, or on Azure the deployment name. Defaults to `gpt-5`. */
  model?: string;
  /**
   * The API key, or a synchronous provider that returns one.
   *
   * The provider's return type is `unknown` because an asynchronous provider
   * is rejected when it is called rather than when it is written, matching
   * adk-python; see {@link OpenAiResponsesLlm.resolveApiKey}.
   */
  apiKey?: string | (() => unknown);
  /** A pre-configured client. Takes precedence over {@link apiKey}. */
  client?: OpenAI;
  /** Whether the API retains the response. */
  store?: boolean;
  /** Extra fields to include on the response. */
  include?: ResponseIncludable[];
  /** The default reasoning config, used when the request sets no thinking. */
  reasoning?: Reasoning;
  /** Whether the model may call several tools at once. */
  parallelToolCalls?: boolean;
  /** What the API truncates when the context overflows. */
  truncation?: 'auto' | 'disabled';
  /** The latency tier to serve the request from. */
  serviceTier?: ServiceTier;
  /** Whether to surface the raw response under `customMetadata`. */
  includeResponseMetadata?: boolean;
  /** Request fields merged last, overriding everything computed. */
  extraRequestArgs?: Partial<ResponsesRequestBody>;
}

/** Settings for the Azure-hosted Responses provider. */
export interface AzureOpenAiResponsesLlmParams extends OpenAiResponsesLlmParams {
  /** The Azure resource endpoint, e.g. `https://example.openai.azure.com/`. */
  azureEndpoint?: string;
}

/**
 * An ADK model backed by the OpenAI Responses API.
 *
 * @experimental Ported from adk-python's `labs` tier and subject to change.
 *
 * For anything beyond the API key — organization, base URL, timeouts, retries,
 * custom headers — pass a pre-configured {@link OpenAI} client as `client`.
 */
export class OpenAiResponsesLlm extends BaseLlm {
  /**
   * Empty, matching `OpenAIResponsesLlm.supported_models()` in adk-python.
   *
   * The `gpt-*` model patterns belong to the chat-completions provider there,
   * so this provider claims none of them and is selected by instantiating it.
   */
  static override readonly supportedModels: Array<string | RegExp> = [];

  protected readonly params: OpenAiResponsesLlmParams;
  private clientInstance?: OpenAI;

  constructor(params: OpenAiResponsesLlmParams = {}) {
    super({model: params.model ?? DEFAULT_MODEL});
    this.params = params;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const includeResponseMetadata = this.params.includeResponseMetadata ?? true;
    const body = buildResponsesRequest(llmRequest, {
      model: this.model,
      stream,
      store: this.params.store,
      include: this.params.include,
      reasoning: this.params.reasoning,
      parallelToolCalls: this.params.parallelToolCalls,
      truncation: this.params.truncation,
      serviceTier: this.params.serviceTier,
      extraRequestArgs: this.params.extraRequestArgs,
    });

    if (!stream) {
      // Two call sites rather than one: `responses.create` is overloaded on
      // the literal type of `stream`, so a dynamic boolean would widen the
      // return type to a union of a response and a stream.
      const response = await this.openaiClient.responses.create(
        {...body, stream: false},
        {signal: abortSignal},
      );
      yield responseToLlmResponse(response, {includeResponseMetadata});
      return;
    }

    const accumulator = new StreamAccumulator(includeResponseMetadata);
    const events = await this.openaiClient.responses.create(
      {...body, stream: true},
      {signal: abortSignal},
    );
    for await (const event of events) {
      yield* accumulator.processEvent(event);
    }
    const finalResponse = accumulator.finalResponse();
    if (finalResponse) {
      yield finalResponse;
    }
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error(`Live connection is not supported for ${this.model}.`);
  }

  /** The client, built on first use so a missing key fails at call time. */
  protected get openaiClient(): OpenAI {
    this.clientInstance ??= this.params.client ?? this.buildClient();
    return this.clientInstance;
  }

  protected buildClient(): OpenAI {
    return new OpenAI({apiKey: this.resolveApiKey()});
  }

  /**
   * Resolves the configured API key.
   *
   * @throws when the key provider is asynchronous.
   */
  protected resolveApiKey(): string | undefined {
    const apiKey = this.params.apiKey;
    if (typeof apiKey !== 'function') {
      return apiKey;
    }
    const resolved: unknown = apiKey();
    if (typeof resolved !== 'string') {
      throw new Error(
        'Async api_key providers are not supported; provide a sync callable' +
          ' that returns a string, or a string.',
      );
    }
    return resolved;
  }
}

/**
 * An ADK model backed by an Azure-hosted OpenAI Responses deployment.
 *
 * @experimental Ported from adk-python's `labs` tier and subject to change.
 *
 * Azure exposes the Responses API through an OpenAI-compatible
 * `/openai/v1/responses` endpoint, so this drives the plain OpenAI client
 * against that base URL rather than the SDK's Azure client. `model` is the
 * deployment name.
 */
export class AzureOpenAiResponsesLlm extends OpenAiResponsesLlm {
  private readonly azureEndpoint?: string;

  constructor(params: AzureOpenAiResponsesLlmParams = {}) {
    super(params);
    this.azureEndpoint = params.azureEndpoint;
  }

  protected override buildClient(): OpenAI {
    const apiKey = this.resolveApiKey();
    if (!this.azureEndpoint) {
      return new OpenAI({apiKey});
    }
    const baseURL =
      this.azureEndpoint.replace(/\/+$/, '') + AZURE_OPENAI_V1_PATH;
    return new OpenAI({apiKey, baseURL});
  }

  protected override resolveApiKey(): string | undefined {
    return super.resolveApiKey() ?? process.env['AZURE_OPENAI_API_KEY'];
  }
}
