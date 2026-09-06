/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenAI Responses API integration for GPT models.
 *
 * Ported from adk-python
 * `src/google/adk/labs/openai/_openai_responses_llm.py`.
 */

import {GenerateContentConfig} from '@google/genai';
import type {OpenAI} from 'openai';

import {loadOptionalPeer} from '../utils/optional_peer.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';
import {
  CallIdSanitizer,
  contentToResponseInputItems,
  functionDeclarationToResponseTool,
  openaiReasoningConfig,
  REASONING_NOT_GIVEN,
  responseTextConfig,
  responseToLlmResponse,
  serializeSystemInstruction,
  toolChoice,
} from './openai_responses_converters.js';
import {StreamAccumulator} from './openai_responses_stream.js';

/** The model used when the caller names none. */
const DEFAULT_RESPONSES_MODEL = 'gpt-5';

/** Names the feature in the error raised when `openai` is not installed. */
const OPENAI_RESPONSES_FEATURE =
  'OpenAIResponsesLlm (GPT models via the OpenAI Responses API)';

/** Path appended to an Azure endpoint to reach its OpenAI-compatible API. */
const AZURE_OPENAI_V1_PATH = '/openai/v1/';

/** Environment variable an Azure model falls back to for its key. */
const AZURE_API_KEY_ENV = 'AZURE_OPENAI_API_KEY';

/**
 * The body sent to `POST /v1/responses`.
 *
 * The SDK's own params type, widened to also carry fields it does not declare.
 * Two of those are needed: `stop`, which the API accepts and the SDK omits,
 * and whatever a caller puts in
 * {@link OpenAIResponsesLlmParams.extraRequestArgs}. The SDK serializes the
 * body object as it is given, so an undeclared key reaches the wire unchanged.
 * Every declared field stays type-checked.
 */
export type ResponsesRequestBody = OpenAI.Responses.ResponseCreateParams &
  Record<string, unknown>;

/**
 * The Responses surface {@link OpenAIResponsesLlm} calls.
 *
 * Only the two overloads ADK uses are named, so a test double or an
 * OpenAI-compatible client can stand in for the SDK client.
 */
export interface OpenAIResponses {
  create(
    body: ResponsesRequestBody & {stream?: false | null},
    options?: {signal?: AbortSignal},
  ): Promise<OpenAI.Responses.Response>;
  create(
    body: ResponsesRequestBody & {stream: true},
    options?: {signal?: AbortSignal},
  ): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>;
}

/** The client surface {@link OpenAIResponsesLlm} calls. */
export interface OpenAIResponsesClient {
  readonly responses: OpenAIResponses;
}

/** Parameters for constructing an {@link OpenAIResponsesLlm}. */
export interface OpenAIResponsesLlmParams {
  /** The OpenAI model to call. Defaults to `gpt-5`. */
  model?: string;
  /**
   * The API key, or a synchronous callable returning it. Without one the SDK
   * reads `OPENAI_API_KEY` from the environment.
   */
  apiKey?: string | (() => string);
  /**
   * A pre-configured client. Supply one to reach an OpenAI-compatible host, or
   * to set an organization, timeout or retry policy explicitly.
   */
  client?: OpenAIResponsesClient;
  /** Whether the API stores the response for later retrieval. */
  store?: boolean;
  /** Extra output the API should include, e.g. encrypted reasoning. */
  include?: OpenAI.Responses.ResponseIncludable[];
  /**
   * Reasoning config used when the request carries no thinking config. A
   * request's thinking config wins over it.
   */
  reasoning?: OpenAI.Reasoning;
  /** Whether the model may emit several tool calls at once. */
  parallelToolCalls?: boolean;
  /** What the API does when the input exceeds the context window. */
  truncation?: 'auto' | 'disabled';
  /** The latency tier to bill the request at. */
  serviceTier?: OpenAI.Responses.ServiceTier;
  /**
   * Whether to attach the raw response under
   * `LlmResponse.customMetadata.openai_response`. Defaults to `true`.
   */
  includeResponseMetadata?: boolean;
  /**
   * Extra request fields, applied last so they override computed ones. Use it
   * for an API field this SDK version does not declare.
   */
  extraRequestArgs?: Record<string, unknown>;
}

/** Parameters for constructing an {@link AzureOpenAIResponsesLlm}. */
export interface AzureOpenAIResponsesLlmParams extends OpenAIResponsesLlmParams {
  /** The Azure resource endpoint, e.g. `https://my-resource.openai.azure.com`. */
  azureEndpoint?: string;
}

/** Returns true when `value` is a promise a caller forgot to await. */
function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/**
 * Returns the key an API-key provider produced.
 *
 * The parameter is `unknown` because this guard exists for JavaScript callers.
 * TypeScript already rejects an async provider, JavaScript does not, and a
 * promise handed to the SDK as the key fails far from its cause.
 *
 * @param value The configured key, or what the provider returned.
 * @return The key, or `undefined` when none is configured.
 * @throws TypeError if the provider returned a promise.
 */
export function requireSyncApiKey(value: unknown): string | undefined {
  if (isThenable(value)) {
    throw new TypeError(
      'Async api_key providers are not supported; provide a synchronous ' +
        'callable that returns a string, or a string.',
    );
  }
  return typeof value === 'string' ? value : undefined;
}

/** Loads the SDK and builds a client. */
async function createOpenAIClient(options: {
  apiKey?: string;
  baseURL?: string;
}): Promise<OpenAIResponsesClient> {
  const {OpenAI} = await loadOptionalPeer(
    {packageName: 'openai', feature: OPENAI_RESPONSES_FEATURE},
    () => import('openai'),
  );
  return new OpenAI(options);
}

/** Converts a request's contents into Responses input items. */
function requestInput(llmRequest: LlmRequest): OpenAI.Responses.ResponseInput {
  const sanitizer = new CallIdSanitizer();
  return (llmRequest.contents ?? []).flatMap((content) =>
    contentToResponseInputItems(content, sanitizer),
  );
}

/** Converts every declared function into a Responses function tool. */
function declaredTools(config: GenerateContentConfig): OpenAI.Responses.Tool[] {
  const tools: OpenAI.Responses.Tool[] = [];
  for (const tool of config.tools ?? []) {
    if (!('functionDeclarations' in tool)) {
      continue;
    }
    for (const declaration of tool.functionDeclarations ?? []) {
      tools.push(functionDeclarationToResponseTool(declaration));
    }
  }
  return tools;
}

/** Applies a request's generation config to the request body. */
function applyConfig(
  config: GenerateContentConfig,
  body: ResponsesRequestBody,
): void {
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
  const reasoning = openaiReasoningConfig(config);
  if (reasoning !== REASONING_NOT_GIVEN) {
    body.reasoning = reasoning;
  }
  const tools = declaredTools(config);
  if (tools.length > 0) {
    body.tools = tools;
  }
  const choice = toolChoice(config);
  if (choice) {
    body.tool_choice = choice;
  }
}

/**
 * A `BaseLlm` that calls the OpenAI Responses API.
 *
 * The `openai` package is an optional peer dependency, loaded on first use.
 * The class registers no model pattern, matching adk-python, so an agent has
 * to be given an instance rather than a model name.
 *
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'assistant',
 *   model: new OpenAIResponsesLlm({model: 'gpt-5'}),
 * });
 * ```
 */
export class OpenAIResponsesLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [];

  protected readonly apiKey?: string | (() => string);
  private readonly store?: boolean;
  private readonly include?: OpenAI.Responses.ResponseIncludable[];
  private readonly reasoning?: OpenAI.Reasoning;
  private readonly parallelToolCalls?: boolean;
  private readonly truncation?: 'auto' | 'disabled';
  private readonly serviceTier?: OpenAI.Responses.ServiceTier;
  private readonly includeResponseMetadata: boolean;
  private readonly extraRequestArgs: Record<string, unknown>;
  private clientPromise?: Promise<OpenAIResponsesClient>;

  constructor(params: OpenAIResponsesLlmParams = {}) {
    super({model: params.model ?? DEFAULT_RESPONSES_MODEL});
    this.apiKey = params.apiKey;
    this.store = params.store;
    this.include = params.include;
    this.reasoning = params.reasoning;
    this.parallelToolCalls = params.parallelToolCalls;
    this.truncation = params.truncation;
    this.serviceTier = params.serviceTier;
    this.includeResponseMetadata = params.includeResponseMetadata ?? true;
    this.extraRequestArgs = params.extraRequestArgs ?? {};
    this.clientPromise = params.client && Promise.resolve(params.client);
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const responses = (await this.resolveClient()).responses;
    const body = this.buildRequestBody(llmRequest);
    const options = {signal: abortSignal};

    if (!stream) {
      const response = await responses.create(
        {...body, stream: false},
        options,
      );
      yield responseToLlmResponse(response, {
        includeResponseMetadata: this.includeResponseMetadata,
      });
      return;
    }

    const accumulator = new StreamAccumulator({
      includeResponseMetadata: this.includeResponseMetadata,
    });
    const events = await responses.create({...body, stream: true}, options);
    for await (const event of events) {
      yield* accumulator.processEvent(event);
    }
    const final = accumulator.finalResponse();
    if (final) {
      yield final;
    }
  }

  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(
      new Error(`Live connection is not supported for ${this.model}.`),
    );
  }

  /** Builds the request body for one ADK request. */
  private buildRequestBody(llmRequest: LlmRequest): ResponsesRequestBody {
    const config = llmRequest.config ?? {};
    const body: ResponsesRequestBody = {
      model: llmRequest.model ?? this.model,
      input: requestInput(llmRequest),
    };

    const instructions = serializeSystemInstruction(config.systemInstruction);
    if (instructions) {
      body.instructions = instructions;
    }
    if (llmRequest.previousInteractionId) {
      body.previous_response_id = llmRequest.previousInteractionId;
    }

    applyConfig(config, body);
    this.applyModelOptions(body);
    return {...body, ...this.extraRequestArgs};
  }

  /** Applies the options the model was constructed with. */
  private applyModelOptions(body: ResponsesRequestBody): void {
    // `store: false` and `parallelToolCalls: false` are meaningful, so each
    // option is tested against `undefined` rather than for truthiness.
    if (this.store !== undefined) {
      body.store = this.store;
    }
    if (this.include !== undefined) {
      body.include = this.include;
    }
    if (this.reasoning !== undefined && body.reasoning === undefined) {
      body.reasoning = this.reasoning;
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
  }

  /**
   * Returns the client, building the default one at most once.
   *
   * The promise is memoised rather than the client, so concurrent requests
   * share a single load of the SDK and a single credential resolution.
   */
  private resolveClient(): Promise<OpenAIResponsesClient> {
    return (this.clientPromise ??= this.createClient());
  }

  /** Builds the client to use when the caller supplied none. */
  protected createClient(): Promise<OpenAIResponsesClient> {
    return createOpenAIClient({apiKey: this.resolveApiKey()});
  }

  /** Resolves the configured API key, invoking a provider if one was given. */
  protected resolveApiKey(): string | undefined {
    return requireSyncApiKey(
      typeof this.apiKey === 'function' ? this.apiKey() : this.apiKey,
    );
  }
}

/**
 * An {@link OpenAIResponsesLlm} against Azure's OpenAI-compatible endpoint.
 *
 * Azure exposes the Responses API at `/openai/v1/responses`, so only the base
 * URL and the key source differ. `model` is the Azure deployment name.
 *
 * ```ts
 * const model = new AzureOpenAIResponsesLlm({
 *   model: 'my-gpt-5-deployment',
 *   azureEndpoint: 'https://my-resource.openai.azure.com',
 * });
 * ```
 */
export class AzureOpenAIResponsesLlm extends OpenAIResponsesLlm {
  private readonly azureEndpoint?: string;

  constructor(params: AzureOpenAIResponsesLlmParams = {}) {
    super(params);
    this.azureEndpoint = params.azureEndpoint;
  }

  protected override createClient(): Promise<OpenAIResponsesClient> {
    const apiKey = this.resolveApiKey();
    if (!this.azureEndpoint) {
      return createOpenAIClient({apiKey});
    }
    const baseURL =
      this.azureEndpoint.replace(/\/+$/, '') + AZURE_OPENAI_V1_PATH;
    return createOpenAIClient({apiKey, baseURL});
  }

  /** Falls back to `AZURE_OPENAI_API_KEY` when no key was configured. */
  protected override resolveApiKey(): string | undefined {
    return super.resolveApiKey() ?? process.env[AZURE_API_KEY_ENV];
  }
}
