/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GPT models driven through the OpenAI Responses API.
 *
 * Ported from `src/google/adk/labs/openai/_openai_responses_llm.py` in
 * google/adk-python.
 */

import {BaseLlm} from '../../models/base_llm.js';
import {BaseLlmConnection} from '../../models/base_llm_connection.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {experimental} from '../../utils/experimental.js';
import {loadOptionalPeer, OptionalPeer} from '../../utils/optional_peer.js';

import {
  buildResponsesCreateParams,
  OpenAIReasoningConfig,
  OpenAIResponse,
  OpenAIStreamEvent,
  ResponsesRequestOptions,
  responseToLlmResponse,
} from './openai_responses_converters.js';
import {streamResponses} from './openai_responses_stream.js';

/** The optional peer backing the OpenAI Responses models. */
const OPENAI_SDK: OptionalPeer = {
  packageName: 'openai',
  feature: 'OpenAIResponsesLlm (GPT models via the OpenAI Responses API)',
};

/** Model called when the caller names none. */
const DEFAULT_MODEL = 'gpt-5';

/** Environment variable the Azure model falls back to for its key. */
const AZURE_API_KEY_ENV = 'AZURE_OPENAI_API_KEY';

/** Path Azure serves its OpenAI-compatible Responses API on. */
const AZURE_RESPONSES_PATH = '/openai/v1/';

const ASYNC_API_KEY_MESSAGE =
  'Async apiKey providers are not supported; provide a sync callable that ' +
  'returns a string, or a string.';

/**
 * Supplies the API key for the client this model builds.
 *
 * ADK resolves the key synchronously, so the provider must return a string. An
 * untyped JavaScript caller can still pass an async provider, which is
 * rejected with a clear error when the key is resolved.
 */
export type OpenAIApiKeyProvider = () => string;

/** Per-request options ADK passes to the OpenAI client. */
export interface OpenAIRequestOptions {
  signal?: AbortSignal;
}

/** The `responses` resource of an {@link OpenAIResponsesClient}. */
export interface OpenAIResponsesResource {
  /**
   * Creates a response, or the event stream of one.
   *
   * The result is `unknown` because the two clients ADK accepts describe the
   * same JSON differently: `OpenAI` from the `openai` package types it with
   * the SDK's own unions, and an injected double types it with
   * {@link OpenAIResponse} and {@link OpenAIStreamEvent}. ADK narrows the
   * result to whichever shape arrived.
   */
  create(
    body: Record<string, unknown>,
    options?: OpenAIRequestOptions,
  ): Promise<unknown>;
}

/**
 * The client surface ADK uses.
 *
 * `OpenAI` from the `openai` package satisfies it structurally, so a caller
 * can inject a pre-configured client, a client pointed at an
 * OpenAI-compatible host, or a test double.
 */
export interface OpenAIResponsesClient {
  readonly responses: OpenAIResponsesResource;
}

/** Constructor parameters for {@link OpenAIResponsesLlm}. */
export interface OpenAIResponsesLlmParams {
  /** The model to call. Defaults to `gpt-5`. */
  model?: string;
  /** The API key, or a synchronous provider for it. */
  apiKey?: string | OpenAIApiKeyProvider;
  /** A pre-configured client, used instead of building one. */
  client?: OpenAIResponsesClient;
  /** Whether OpenAI stores the response for later retrieval. */
  store?: boolean;
  /** Extra output to include, e.g. `reasoning.encrypted_content`. */
  include?: string[];
  /** Reasoning effort applied when the request states no preference. */
  reasoning?: OpenAIReasoningConfig;
  /** Whether the model may emit several tool calls in one turn. */
  parallelToolCalls?: boolean;
  /** How OpenAI truncates a conversation that exceeds the context window. */
  truncation?: string;
  /** The service tier to bill and schedule the request under. */
  serviceTier?: string;
  /** Whether to keep the raw payload on `customMetadata`. Defaults to true. */
  includeResponseMetadata?: boolean;
  /** Extra fields merged into every request body. */
  extraRequestArgs?: Record<string, unknown>;
}

/** Constructor parameters for {@link AzureOpenAIResponsesLlm}. */
export interface AzureOpenAIResponsesLlmParams extends OpenAIResponsesLlmParams {
  /** The Azure resource endpoint, e.g. `https://x.openai.azure.com`. */
  azureEndpoint?: string;
}

/** Options ADK passes when it constructs the OpenAI client itself. */
export interface OpenAIClientOptions {
  apiKey?: string;
  baseURL?: string;
}

/** Returns true when `value` is promise-like, i.e. has a callable `then`. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/** Returns true when the client returned a stream rather than a response. */
function isEventStream(
  result: unknown,
): result is AsyncIterable<OpenAIStreamEvent> {
  return (
    typeof result === 'object' &&
    result !== null &&
    Symbol.asyncIterator in result
  );
}

/**
 * Returns true when `result` can be read as a Responses payload.
 *
 * Every field of {@link OpenAIResponse} is optional and every reader handles
 * its absence, so any JSON object qualifies. This rejects a non-object
 * result, which the conversion could not read at all.
 */
function isResponsePayload(result: unknown): result is OpenAIResponse {
  return typeof result === 'object' && result !== null;
}

/**
 * GPT models through the OpenAI Responses API.
 *
 * The model is deliberately not registered against any model name, matching
 * adk-python: construct it and assign it to an agent's `model` field.
 *
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'assistant',
 *   model: new OpenAIResponsesLlm({model: 'gpt-5'}),
 *   instruction: 'You are a helpful assistant.',
 * });
 * ```
 *
 * For anything the constructor does not expose — organization, timeout,
 * retries, custom headers, an OpenAI-compatible host — build an `OpenAI`
 * client yourself and pass it as `client`. To send every request to one
 * compatible host instead, leave `client` unset and set `OPENAI_BASE_URL`,
 * which the default client reads.
 */
@experimental
export class OpenAIResponsesLlm extends BaseLlm {
  /**
   * Empty on purpose: the Responses models are never resolved from a bare
   * model string, so a `gpt-*` name does not silently pick this class.
   */
  static override readonly supportedModels: Array<string | RegExp> = [];

  /** Whether OpenAI stores the response for later retrieval. */
  readonly store?: boolean;
  /** Extra output to include, e.g. `reasoning.encrypted_content`. */
  readonly include?: string[];
  /** Reasoning effort applied when the request states no preference. */
  readonly reasoning?: OpenAIReasoningConfig;
  /** Whether the model may emit several tool calls in one turn. */
  readonly parallelToolCalls?: boolean;
  /** How OpenAI truncates a conversation that exceeds the context window. */
  readonly truncation?: string;
  /** The service tier to bill and schedule the request under. */
  readonly serviceTier?: string;
  /** Whether to keep the raw payload on `customMetadata`. */
  readonly includeResponseMetadata: boolean;
  /** Extra fields merged into every request body. */
  readonly extraRequestArgs: Record<string, unknown>;

  /** The key, or its provider, for the client this model builds. */
  protected readonly apiKey?: string | OpenAIApiKeyProvider;
  /** The client the caller injected, if any. */
  protected readonly injectedClient?: OpenAIResponsesClient;

  private clientPromise?: Promise<OpenAIResponsesClient>;

  constructor(params: OpenAIResponsesLlmParams = {}) {
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
    const body = buildResponsesCreateParams(
      llmRequest,
      this.requestOptions(),
      stream,
    );
    const client = await this.getClient();
    const result = await client.responses.create(body, {signal: abortSignal});
    // The API returns an event stream exactly when `stream: true` was sent,
    // so the shape it returned selects the reader.
    if (isEventStream(result)) {
      yield* streamResponses(result, this.includeResponseMetadata);
      return;
    }
    yield responseToLlmResponse(isResponsePayload(result) ? result : {}, {
      includeResponseMetadata: this.includeResponseMetadata,
    });
  }

  /** @throws Always: the Responses API has no bidirectional live mode. */
  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(`Live connection is not supported for ${this.model}.`);
  }

  /**
   * Resolves the API key, calling the provider when one was given.
   *
   * @throws If the provider returns a promise, which would otherwise reach the
   *   client as a stringified object.
   */
  protected resolveApiKey(): string | undefined {
    if (typeof this.apiKey !== 'function') {
      return this.apiKey;
    }
    const key = this.apiKey();
    if (isThenable(key)) {
      throw new Error(ASYNC_API_KEY_MESSAGE);
    }
    return key;
  }

  /** Returns the options ADK builds its own client with. */
  protected clientOptions(): OpenAIClientOptions {
    return {apiKey: this.resolveApiKey()};
  }

  /**
   * Returns the client, creating it on first use.
   *
   * The promise is memoised, so concurrent requests share one client.
   */
  protected async getClient(): Promise<OpenAIResponsesClient> {
    this.clientPromise ??= this.createClient();
    return this.clientPromise;
  }

  /** Builds the client for this model. */
  protected async createClient(): Promise<OpenAIResponsesClient> {
    if (this.injectedClient) {
      return this.injectedClient;
    }
    const {OpenAI} = await loadOptionalPeer(OPENAI_SDK, () => import('openai'));
    return new OpenAI(this.clientOptions());
  }

  private requestOptions(): ResponsesRequestOptions {
    return {
      model: this.model,
      store: this.store,
      include: this.include,
      reasoning: this.reasoning,
      parallelToolCalls: this.parallelToolCalls,
      truncation: this.truncation,
      serviceTier: this.serviceTier,
      extraRequestArgs: this.extraRequestArgs,
    };
  }
}

/**
 * Azure OpenAI through its OpenAI-compatible Responses endpoint.
 *
 * `model` is the Azure deployment name. The key falls back to
 * `AZURE_OPENAI_API_KEY`. This class is experimental, like the base class it
 * extends.
 *
 * ```ts
 * const llm = new AzureOpenAIResponsesLlm({
 *   model: 'my-deployment',
 *   azureEndpoint: 'https://my-resource.openai.azure.com',
 * });
 * ```
 */
export class AzureOpenAIResponsesLlm extends OpenAIResponsesLlm {
  /** The Azure resource endpoint the client is pointed at. */
  readonly azureEndpoint?: string;

  constructor(params: AzureOpenAIResponsesLlmParams = {}) {
    super(params);
    this.azureEndpoint = params.azureEndpoint;
  }

  protected override resolveApiKey(): string | undefined {
    return super.resolveApiKey() || process.env[AZURE_API_KEY_ENV];
  }

  protected override clientOptions(): OpenAIClientOptions {
    const options = super.clientOptions();
    if (this.azureEndpoint) {
      options.baseURL =
        this.azureEndpoint.replace(/\/+$/, '') + AZURE_RESPONSES_PATH;
    }
    return options;
  }
}
