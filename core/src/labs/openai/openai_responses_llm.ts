/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ADK models backed by the OpenAI Responses API.
 *
 * Ports `src/google/adk/labs/openai/_openai_responses_llm.py` from adk-python.
 */

import type OpenAI from 'openai';

import {BaseLlm} from '../../models/base_llm.js';
import {BaseLlmConnection} from '../../models/base_llm_connection.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {experimental} from '../../utils/experimental.js';
import {loadOptionalPeer, OptionalPeer} from '../../utils/optional_peer.js';

import {
  CallIdSanitizer,
  contentToResponseInputItems,
  functionDeclarationToResponseTool,
  openAiReasoningConfig,
  responseTextConfig,
  serializeSystemInstruction,
  toolChoice,
} from './openai_responses_request.js';
import {responseToLlmResponse} from './openai_responses_response.js';
import {StreamAccumulator} from './openai_responses_stream.js';

/** The model used when the caller names none. */
const DEFAULT_MODEL = 'gpt-5';

/** Environment variable holding the Azure OpenAI key. */
const AZURE_OPENAI_API_KEY_ENV = 'AZURE_OPENAI_API_KEY';

/** The optional peer dependency backing these models. */
const OPENAI_PEER: OptionalPeer = {
  packageName: 'openai',
  feature: 'the OpenAI Responses API models',
};

/**
 * An API key, or a function that produces one.
 *
 * A function is called once per client construction, so a key that rotates can
 * be fetched at that moment rather than baked into the model.
 */
export type OpenAiApiKeyProvider = string | (() => string | Promise<string>);

/**
 * The body of a `POST /v1/responses` request.
 *
 * Extends the SDK's own request type with `stop`, which the Responses API
 * accepts on the wire but the SDK does not model.
 */
export interface ResponseCreateBody extends Omit<
  OpenAI.Responses.ResponseCreateParamsNonStreaming,
  'stream'
> {
  stop?: string[];
  stream?: boolean | null;
}

/** Per-request options passed through to the HTTP client. */
export interface OpenAiRequestOptions {
  signal?: AbortSignal;
}

/** The `responses` surface these models call. */
export interface OpenAiResponsesApi {
  create(
    body: ResponseCreateBody & {stream?: false},
    options?: OpenAiRequestOptions,
  ): Promise<OpenAI.Responses.Response>;
  create(
    body: ResponseCreateBody & {stream: true},
    options?: OpenAiRequestOptions,
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
}

/**
 * The client surface these models need.
 *
 * Declared structurally rather than as the concrete `OpenAI` class, so any
 * OpenAI-compatible client — or a test double — can be injected.
 */
export interface OpenAiResponsesClient {
  readonly responses: OpenAiResponsesApi;
}

/** Options for {@link OpenAiResponsesLlm}. */
export interface OpenAiResponsesLlmParams {
  /** The model to call. Defaults to `gpt-5`. */
  model?: string;
  /** The API key. Falls back to the `openai` package's own resolution. */
  apiKey?: OpenAiApiKeyProvider;
  /**
   * A pre-configured client. Supply one to reach an OpenAI-compatible host, or
   * to set an organization, base URL, timeout, retry policy or custom headers.
   */
  client?: OpenAiResponsesClient;
  /** Whether OpenAI stores the response. */
  store?: boolean;
  /** Extra output to include in the response. */
  include?: OpenAI.Responses.ResponseIncludable[];
  /** Reasoning config used when the request carries no thinking config. */
  reasoning?: OpenAI.Reasoning;
  /** Whether the model may run tool calls in parallel. */
  parallelToolCalls?: boolean;
  /** How the API truncates input that exceeds the context window. */
  truncation?: 'auto' | 'disabled';
  /** The latency tier to serve the request from. */
  serviceTier?: OpenAI.Responses.ServiceTier;
  /**
   * Whether to record the raw response under
   * `LlmResponse.customMetadata.openai_response`. Defaults to `true`.
   */
  includeResponseMetadata?: boolean;
  /**
   * Extra request-body fields, merged last so they override computed ones.
   * Use it for Responses parameters this class does not model.
   */
  extraRequestArgs?: Record<string, unknown>;
}

/** Options for {@link AzureOpenAiResponsesLlm}. */
export interface AzureOpenAiResponsesLlmParams extends OpenAiResponsesLlmParams {
  /** The Azure OpenAI resource endpoint, e.g. `https://x.openai.azure.com/`. */
  azureEndpoint?: string;
}

/** Merges caller-supplied request fields, dropping the empty ones. */
function mergeExtraRequestArgs(
  body: ResponseCreateBody,
  extraRequestArgs: Record<string, unknown>,
): ResponseCreateBody {
  const defined = Object.fromEntries(
    Object.entries(extraRequestArgs).filter(
      ([, value]) => value !== undefined && value !== null,
    ),
  );
  return Object.assign(body, defined);
}

/** Collects the function tools declared on a request. */
function requestTools(
  llmRequest: LlmRequest,
): OpenAI.Responses.FunctionTool[] | undefined {
  const tools: OpenAI.Responses.FunctionTool[] = [];
  for (const tool of llmRequest.config?.tools ?? []) {
    if (!('functionDeclarations' in tool)) {
      continue;
    }
    for (const declaration of tool.functionDeclarations ?? []) {
      tools.push(functionDeclarationToResponseTool(declaration));
    }
  }
  return tools.length > 0 ? tools : undefined;
}

/**
 * An ADK model backed by the OpenAI Responses API.
 *
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'assistant',
 *   model: new OpenAiResponsesLlm({model: 'gpt-5'}),
 * });
 * ```
 *
 * Requires the optional peer dependency `openai` unless a `client` is
 * supplied.
 */
@experimental
export class OpenAiResponsesLlm extends BaseLlm {
  private readonly apiKey?: OpenAiApiKeyProvider;
  private readonly injectedClient?: OpenAiResponsesClient;
  private readonly store?: boolean;
  private readonly include?: OpenAI.Responses.ResponseIncludable[];
  private readonly reasoning?: OpenAI.Reasoning;
  private readonly parallelToolCalls?: boolean;
  private readonly truncation?: 'auto' | 'disabled';
  private readonly serviceTier?: OpenAI.Responses.ServiceTier;
  private readonly includeResponseMetadata: boolean;
  private readonly extraRequestArgs: Record<string, unknown>;
  private clientPromise?: Promise<OpenAiResponsesClient>;

  /**
   * These models are passed to an agent directly, never resolved from a model
   * name, so they claim no name patterns.
   */
  static override readonly supportedModels: Array<string | RegExp> = [];

  constructor(params: OpenAiResponsesLlmParams = {}) {
    super({model: params.model ?? DEFAULT_MODEL});
    this.apiKey = params.apiKey;
    this.injectedClient = params.client;
    this.store = params.store;
    this.include = params.include;
    this.reasoning = params.reasoning;
    this.parallelToolCalls = params.parallelToolCalls;
    this.truncation = params.truncation;
    this.serviceTier = params.serviceTier;
    this.includeResponseMetadata = params.includeResponseMetadata ?? true;
    this.extraRequestArgs = params.extraRequestArgs ?? {};
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const client = await this.getClient();
    const body = this.getResponseCreateBody(llmRequest);
    const options: OpenAiRequestOptions = {signal: abortSignal};

    if (!stream) {
      const response = await client.responses.create(
        {...body, stream: false},
        options,
      );
      yield responseToLlmResponse(response, this.includeResponseMetadata);
      return;
    }

    const accumulator = new StreamAccumulator(this.includeResponseMetadata);
    const events = await client.responses.create(
      {...body, stream: true},
      options,
    );
    for await (const event of events) {
      yield* accumulator.processEvent(event);
    }
    const finalResponse = accumulator.finalResponse();
    if (finalResponse) {
      yield finalResponse;
    }
  }

  override connect(): Promise<BaseLlmConnection> {
    return Promise.reject(
      new Error(`Live connection is not supported for ${this.model}.`),
    );
  }

  /**
   * Builds the request body for one ADK request.
   *
   * Field names stay snake_case because they go on the wire.
   */
  getResponseCreateBody(llmRequest: LlmRequest): ResponseCreateBody {
    const config = llmRequest.config ?? {};
    const body: ResponseCreateBody = {
      model: llmRequest.model ?? this.model,
      input: this.getResponseInput(llmRequest),
    };

    const instructions = serializeSystemInstruction(config.systemInstruction);
    if (instructions) {
      body.instructions = instructions;
    }
    if (llmRequest.previousInteractionId) {
      body.previous_response_id = llmRequest.previousInteractionId;
    }
    if (config.temperature !== undefined) {
      body.temperature = config.temperature;
    }
    if (config.topP !== undefined) {
      body.top_p = config.topP;
    }
    if (config.maxOutputTokens !== undefined) {
      body.max_output_tokens = config.maxOutputTokens;
    }
    if (config.stopSequences?.length) {
      body.stop = config.stopSequences;
    }
    const text = responseTextConfig(config);
    if (text) {
      body.text = text;
    }
    const reasoning = openAiReasoningConfig(config) ?? this.reasoning;
    if (reasoning) {
      body.reasoning = reasoning;
    }
    const tools = requestTools(llmRequest);
    if (tools) {
      body.tools = tools;
    }
    const choice = toolChoice(config);
    if (choice) {
      body.tool_choice = choice;
    }
    if (this.store !== undefined) {
      body.store = this.store;
    }
    if (this.include !== undefined) {
      body.include = this.include;
    }
    if (this.parallelToolCalls !== undefined) {
      body.parallel_tool_calls = this.parallelToolCalls;
    }
    if (this.truncation !== undefined) {
      body.truncation = this.truncation;
    }
    if (this.serviceTier !== undefined) {
      body.service_tier = this.serviceTier;
    }

    return mergeExtraRequestArgs(body, this.extraRequestArgs);
  }

  /** Flattens a request's contents into Responses input items. */
  getResponseInput(
    llmRequest: LlmRequest,
  ): OpenAI.Responses.ResponseInputItem[] {
    // One sanitizer per request, so a substituted call ID is stable across the
    // contents of that request and unrelated across requests.
    const sanitizer = new CallIdSanitizer();
    return (llmRequest.contents ?? []).flatMap((content) =>
      contentToResponseInputItems(content, sanitizer),
    );
  }

  /** Resolves the API key, calling a provider function if one was supplied. */
  protected async resolveApiKey(): Promise<string | undefined> {
    return typeof this.apiKey === 'function' ? this.apiKey() : this.apiKey;
  }

  /** Builds the client to use when the caller injected none. */
  protected async createClient(): Promise<OpenAiResponsesClient> {
    const {default: OpenAIClient} = await loadOptionalPeer(
      OPENAI_PEER,
      () => import('openai'),
    );
    return new OpenAIClient({apiKey: await this.resolveApiKey()});
  }

  /** Returns the client, building and caching it on first use. */
  private getClient(): Promise<OpenAiResponsesClient> {
    if (this.injectedClient) {
      return Promise.resolve(this.injectedClient);
    }
    this.clientPromise ??= this.createClient();
    return this.clientPromise;
  }
}

/**
 * An ADK model backed by Azure's OpenAI-compatible Responses API.
 *
 * Azure exposes the Responses API at `/openai/v1/responses` on the resource
 * endpoint. `model` is the deployment name.
 *
 * ```ts
 * new AzureOpenAiResponsesLlm({
 *   model: 'my-deployment',
 *   azureEndpoint: 'https://example.openai.azure.com/',
 * });
 * ```
 */
@experimental
export class AzureOpenAiResponsesLlm extends OpenAiResponsesLlm {
  private readonly azureEndpoint?: string;

  constructor(params: AzureOpenAiResponsesLlmParams = {}) {
    super(params);
    this.azureEndpoint = params.azureEndpoint;
  }

  protected override async resolveApiKey(): Promise<string | undefined> {
    return (
      (await super.resolveApiKey()) ?? process.env[AZURE_OPENAI_API_KEY_ENV]
    );
  }

  protected override async createClient(): Promise<OpenAiResponsesClient> {
    const {default: OpenAIClient} = await loadOptionalPeer(
      OPENAI_PEER,
      () => import('openai'),
    );
    const apiKey = await this.resolveApiKey();
    return this.azureEndpoint
      ? new OpenAIClient({
          apiKey,
          baseURL: `${this.azureEndpoint.replace(/\/+$/, '')}/openai/v1/`,
        })
      : new OpenAIClient({apiKey});
  }
}
