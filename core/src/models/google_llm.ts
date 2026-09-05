/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Blob,
  FileData,
  GoogleGenAI,
  GoogleGenAIOptions,
  HttpOptions,
  HttpRetryOptions,
  LiveServerMessage,
  SpeechConfig,
} from '@google/genai';

import {asResourceExhaustedError} from '../errors/resource_exhausted_error.js';
import {isBrowser, isEnterpriseModeEnabled} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {asSafePartForLlm} from '../utils/part_utils.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

import {AsyncQueue} from '../utils/async_queue.js';
import {
  normalizeBaseUrlAndApiVersion,
  NormalizedBaseUrl,
} from '../utils/base_url_utils.js';
import {StreamingResponseAggregator} from '../utils/streaming_utils.js';
import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {GeminiLlmConnection} from './gemini_llm_connection.js';
import {generateContentViaInteractions} from './interactions_utils.js';
import {LlmRequest} from './llm_request.js';
import {createLlmResponse, LlmResponse} from './llm_response.js';

/**
 * The parameters for creating a Gemini instance.
 */
export interface GeminiParams {
  /**
   * The name of the model to use. Defaults to 'gemini-2.5-flash'.
   */
  model?: string;
  /**
   * The API key to use for the Gemini API. If not provided, it will look for
   * the GOOGLE_GENAI_API_KEY, GOOGLE_API_KEY or GEMINI_API_KEY environment
   * variable, in that order.
   */
  apiKey?: string;
  /**
   * Whether to use Vertex AI. If true, `project`, `location`
   * should be provided.
   */
  vertexai?: boolean;
  /**
   * The Vertex AI project ID. Required if `vertexai` is true.
   */
  project?: string;
  /**
   * The Vertex AI location. Required if `vertexai` is true.
   */
  location?: string;
  /**
   * Headers to merge with internally crafted headers.
   */
  headers?: Record<string, string>;
  /**
   * Whether to use the Interactions API for stateful conversations.
   */
  useInteractionsApi?: boolean;
  /**
   * The base URL for the service endpoint. A Google API version suffix in the
   * path (e.g. a trailing `/v1alpha`) is lifted out into the API version.
   */
  baseUrl?: string;
  /**
   * The API version for the non-live service endpoint.
   *
   * For the Vertex AI backend the google-genai SDK defaults to `v1beta1`,
   * which exposes preview features. Set this to `v1` for the GA endpoint.
   * When unset, the `GOOGLE_GENAI_API_VERSION` environment variable is
   * consulted, and finally the SDK's own default applies. A version embedded
   * in `baseUrl` wins over this field.
   */
  apiVersion?: string;
  /**
   * A pre-configured google-genai client. When set it serves both the
   * generate-content and the live path, and ADK constructs no client of its
   * own, so `clientKwargs` is ignored.
   */
  client?: GoogleGenAI;
  /**
   * Extra options for the google-genai client constructor. They are merged
   * over the options ADK computes, so they win.
   */
  clientKwargs?: Partial<GoogleGenAIOptions>;
  /**
   * The retry policy for failed responses. It applies to the non-live client
   * only.
   */
  retryOptions?: HttpRetryOptions;
  /**
   * The speech configuration for live sessions. It overrides a speech config
   * already on the request.
   */
  speechConfig?: SpeechConfig;
}

const GEMINI_MODEL_SYMBOL = Symbol.for('google.adk.geminiModel');
const API_VERSION_ENV_VARIABLE_NAME = 'GOOGLE_GENAI_API_VERSION';
const ENTERPRISE_MODEL_PREFIX = 'projects/';
// Inline data carries no filename, so this stands in for the artifact name
// `asSafePartForLlm` requires.
const INLINE_FILE_ARTIFACT_NAME = 'inline-file';

/**
 * Type guard to check if an object is an instance of Gemini.
 * @param obj The object to check.
 * @returns True if the object is an instance of Gemini, false otherwise.
 */
export function isGemini(obj: unknown): obj is Gemini {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    GEMINI_MODEL_SYMBOL in obj &&
    obj[GEMINI_MODEL_SYMBOL] === true
  );
}

/**
 * Integration for Gemini models.
 */
export class Gemini extends BaseLlm {
  readonly [GEMINI_MODEL_SYMBOL] = true;
  private readonly apiKey?: string;
  protected readonly vertexai: boolean;
  private readonly project?: string;
  private readonly location?: string;
  private readonly headers?: Record<string, string>;
  readonly useInteractionsApi: boolean;
  private readonly apiVersion?: string;
  private readonly client?: GoogleGenAI;
  private readonly clientKwargs?: Partial<GoogleGenAIOptions>;
  private readonly retryOptions?: HttpRetryOptions;
  private readonly speechConfig?: SpeechConfig;
  private readonly normalizedBaseUrl: NormalizedBaseUrl;

  /**
   * @param params The parameters for creating a Gemini instance.
   */
  constructor({
    model,
    apiKey,
    vertexai,
    project,
    location,
    headers,
    useInteractionsApi,
    baseUrl,
    apiVersion,
    client,
    clientKwargs,
    retryOptions,
    speechConfig,
  }: GeminiParams) {
    if (!model) {
      model = 'gemini-2.5-flash';
    }

    super({model});

    const params = geminiInitParams({
      model,
      vertexai,
      project,
      location,
      apiKey,
    });
    if (!params.vertexai && !params.apiKey) {
      throw new Error(
        'API key must be provided via constructor or the GOOGLE_GENAI_API_KEY, GOOGLE_API_KEY or GEMINI_API_KEY environment variable.',
      );
    }
    this.project = params.project;
    this.location = params.location;
    this.apiKey = params.apiKey;
    this.headers = headers;
    this.vertexai = !!params.vertexai;
    this.useInteractionsApi = !!useInteractionsApi;
    this.apiVersion = apiVersion;
    this.client = client;
    this.clientKwargs = clientKwargs;
    this.retryOptions = retryOptions;
    this.speechConfig = speechConfig;
    this.normalizedBaseUrl = normalizeBaseUrlAndApiVersion(baseUrl);
  }

  /**
   * A list of model name patterns that are supported by this LLM.
   *
   * @returns A list of supported models.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /gemini-.*/,
    // Gemma 4+ works natively with Gemini (no workarounds needed).
    /gemma-4.*/,
    // model optimizer pattern
    /model-optimizer-.*/,
    // fine-tuned vertex endpoint pattern
    /projects\/.+\/locations\/.+\/endpoints\/.+/,
    // vertex gemini long name
    /projects\/.+\/locations\/.+\/publishers\/google\/models\/gemini.+/,
  ];

  private _apiClient?: GoogleGenAI;
  private _apiBackend?: GoogleLLMVariant;
  private _trackingHeaders?: Record<string, string>;
  private _liveApiVersion?: string;
  private _liveApiClient?: GoogleGenAI;

  /**
   * Sends a request to the Gemini model.
   *
   * @param llmRequest LlmRequest, the request to send to the Gemini model.
   * @param stream bool = false, whether to do streaming call.
   * @yields LlmResponse: The model response.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.preprocessRequest(llmRequest);
    this.maybeAppendUserContent(llmRequest);
    logger.info(
      `Sending out request, model: ${llmRequest.model ?? this.model}, backend: ${this.apiBackend}, stream: ${stream}`,
    );

    if (!llmRequest.config) {
      llmRequest.config = {};
    }

    // Tracking headers always go on the request, because per-request HTTP
    // options override the ones the client was constructed with.
    const httpOptions = llmRequest.config.httpOptions ?? {};
    httpOptions.headers = {...httpOptions.headers, ...this.trackingHeaders};
    const apiVersion = this.normalizedBaseUrl.apiVersion ?? this.apiVersion;
    if (apiVersion && !httpOptions.apiVersion) {
      httpOptions.apiVersion = apiVersion;
    }
    llmRequest.config.httpOptions = httpOptions;

    if (abortSignal) {
      llmRequest.config.abortSignal = abortSignal;
    }

    try {
      if (this.useInteractionsApi) {
        yield* generateContentViaInteractions(
          this.apiClient,
          llmRequest,
          stream,
        );
        return;
      }

      if (stream) {
        const streamResult = await this.apiClient.models.generateContentStream({
          model: llmRequest.model ?? this.model,
          contents: llmRequest.contents,
          config: llmRequest.config,
        });

        const aggregator = new StreamingResponseAggregator();
        for await (const response of streamResult) {
          for await (const llmResponse of aggregator.processResponse(
            response,
          )) {
            yield llmResponse;
          }
        }
        const finalResponse = aggregator.close();
        if (finalResponse) {
          yield finalResponse;
        }
      } else {
        const response = await this.apiClient.models.generateContent({
          model: llmRequest.model ?? this.model,
          contents: llmRequest.contents,
          config: llmRequest.config,
        });
        yield createLlmResponse(response);
      }
    } catch (e: unknown) {
      throw asResourceExhaustedError(e) ?? e;
    }
  }

  protected getHttpOptions(): HttpOptions {
    // The SDK skips an undefined scalar when it merges these over its own
    // defaults, so an unresolved value leaves the default in place.
    return {
      headers: {...this.trackingHeaders, ...this.headers},
      baseUrl: this.normalizedBaseUrl.baseUrl,
      retryOptions: this.retryOptions,
      apiVersion: this.configuredApiVersion(),
    };
  }

  /**
   * Returns the API version configured for the non-live endpoint.
   *
   * The `apiVersion` field wins over the `GOOGLE_GENAI_API_VERSION`
   * environment variable. A version embedded in `baseUrl` wins over both.
   */
  private configuredApiVersion(): string | undefined {
    return (
      this.normalizedBaseUrl.apiVersion ||
      this.apiVersion ||
      (isBrowser() ? undefined : process.env[API_VERSION_ENV_VARIABLE_NAME]) ||
      undefined
    );
  }

  /** Options ADK computes for both clients, before `clientKwargs`. */
  private clientOptions(): Partial<GoogleGenAIOptions> {
    const backendOptions: Partial<GoogleGenAIOptions> = this.vertexai
      ? {vertexai: true, project: this.project, location: this.location}
      : {apiKey: this.apiKey};
    if (this.model.startsWith(ENTERPRISE_MODEL_PREFIX)) {
      backendOptions.enterprise = true;
    }
    return backendOptions;
  }

  get apiClient(): GoogleGenAI {
    if (this.client) {
      return this.client;
    }
    if (!this._apiClient) {
      this._apiClient = new GoogleGenAI({
        ...this.clientOptions(),
        httpOptions: this.getHttpOptions(),
        ...this.clientKwargs,
      });
    }
    return this._apiClient;
  }

  get apiBackend(): GoogleLLMVariant {
    if (!this._apiBackend) {
      this._apiBackend = this.apiClient.vertexai
        ? GoogleLLMVariant.VERTEX_AI
        : GoogleLLMVariant.GEMINI_API;
    }
    return this._apiBackend;
  }

  get liveApiVersion(): string {
    if (!this._liveApiVersion) {
      // The `apiVersion` field and the environment variable are deliberately
      // ignored here: the live endpoint has its own per-backend version.
      // Vertex uses the beta API; the AI Studio backend uses v1alpha.
      this._liveApiVersion =
        this.normalizedBaseUrl.apiVersion ??
        (this.apiBackend === GoogleLLMVariant.VERTEX_AI
          ? 'v1beta1'
          : 'v1alpha');
    }
    return this._liveApiVersion;
  }

  protected getLiveHttpOptions(): HttpOptions {
    return {
      headers: this.trackingHeaders,
      apiVersion: this.liveApiVersion,
      baseUrl: this.normalizedBaseUrl.baseUrl,
    };
  }

  get liveApiClient(): GoogleGenAI {
    if (this.client) {
      return this.client;
    }
    if (!this._liveApiClient) {
      const options = this.clientOptions();
      if (options.vertexai) {
        options.location = this.location || 'global';
      }
      this._liveApiClient = new GoogleGenAI({
        ...options,
        httpOptions: this.getLiveHttpOptions(),
        ...this.clientKwargs,
      });
    }
    return this._liveApiClient;
  }

  /**
   * Connects to the Gemini model and returns an llm connection.
   *
   * @param llmRequest LlmRequest, the request to send to the Gemini model.
   * @returns BaseLlmConnection, the connection to the Gemini model.
   */
  override async connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    // add tracking headers to custom headers and set api_version given
    // the customized http options will override the one set in the api client
    // constructor
    if (llmRequest.liveConnectConfig?.httpOptions) {
      if (!llmRequest.liveConnectConfig.httpOptions.headers) {
        llmRequest.liveConnectConfig.httpOptions.headers = {};
      }
      Object.assign(
        llmRequest.liveConnectConfig.httpOptions.headers,
        this.trackingHeaders,
      );
      llmRequest.liveConnectConfig.httpOptions.apiVersion = this.liveApiVersion;
    }

    if (this.speechConfig) {
      llmRequest.liveConnectConfig.speechConfig = this.speechConfig;
    }

    // Assigned unconditionally: with no system instruction the wire format is
    // still a system Content holding one empty part, so skipping the
    // assignment changes what every live connect sends.
    const systemInstruction = llmRequest.config?.systemInstruction;
    llmRequest.liveConnectConfig.systemInstruction = {
      role: 'system',
      parts: [
        {
          text:
            typeof systemInstruction === 'string'
              ? systemInstruction
              : undefined,
        },
      ],
    };

    llmRequest.liveConnectConfig.tools = llmRequest.config?.tools;

    if (llmRequest.config?.thinkingConfig !== undefined) {
      llmRequest.liveConnectConfig.thinkingConfig =
        llmRequest.config.thinkingConfig;
    }

    // Safety settings come from the agent's generate-content config, which only
    // populates `config`. Forward them so a live run honours the same
    // configuration, but let an explicit live value win.
    if (
      llmRequest.config?.safetySettings !== undefined &&
      llmRequest.liveConnectConfig.safetySettings === undefined
    ) {
      llmRequest.liveConnectConfig.safetySettings =
        llmRequest.config.safetySettings;
    }

    // Gemini API (AI Studio) rejects `sessionResumption.transparent`; it is a
    // Vertex-only flag. Strip it so callers can set a uniform resumption config
    // regardless of backend.
    if (this.apiBackend === GoogleLLMVariant.GEMINI_API) {
      const resumption = llmRequest.liveConnectConfig.sessionResumption as
        | {transparent?: boolean}
        | undefined;
      if (resumption) {
        delete resumption.transparent;
      }
    }

    const modelVersion = llmRequest.model ?? this.model;
    const messageQueue = new AsyncQueue<LiveServerMessage>();

    const liveSession = await this.liveApiClient.live.connect({
      model: modelVersion,
      config: llmRequest.liveConnectConfig,
      callbacks: {
        onmessage: (message) => {
          messageQueue.push(message);
        },
        onerror: (error) => {
          messageQueue.error(error);
        },
        onclose: () => {
          messageQueue.close();
        },
      },
    });
    return new GeminiLlmConnection(liveSession, modelVersion, messageQueue);
  }

  private preprocessRequest(llmRequest: LlmRequest): void {
    if (this.apiBackend === GoogleLLMVariant.GEMINI_API) {
      if (llmRequest.config) {
        // Using API key from Google AI Studio to call model doesn't support
        // labels.
        (llmRequest.config as {labels?: unknown}).labels = undefined;
      }
      if (llmRequest.contents) {
        for (const content of llmRequest.contents) {
          if (!content.parts) continue;
          for (const part of content.parts) {
            removeDisplayNameIfPresent(part.inlineData);
            removeDisplayNameIfPresent(part.fileData);
          }
        }
      }
    }

    if (
      llmRequest.config?.tools?.some(
        (tool) => 'computerUse' in tool && !!tool.computerUse,
      )
    ) {
      llmRequest.config.systemInstruction = undefined;
    }

    // An unsupported inline type (a DOCX dropped into the UI, say) reaches the
    // model as plain text instead of raw bytes it cannot read.
    if (llmRequest.contents) {
      for (const content of llmRequest.contents) {
        if (!content.parts) continue;
        content.parts = content.parts.map((part) =>
          asSafePartForLlm(part, INLINE_FILE_ARTIFACT_NAME),
        );
      }
    }
  }
}

function removeDisplayNameIfPresent(
  dataObj: Blob | FileData | undefined,
): void {
  // display_name is not supported for Gemini API (non-vertex)
  if (dataObj && (dataObj as FileData).displayName) {
    (dataObj as FileData).displayName = undefined;
  }
}

export function geminiInitParams({
  model,
  vertexai,
  project,
  location,
  apiKey,
}: GeminiParams) {
  const params: GeminiParams = {model, vertexai, project, location, apiKey};

  params.vertexai = !!vertexai;
  if (!params.vertexai && !isBrowser()) {
    params.vertexai = isEnterpriseModeEnabled();
  }

  if (params.vertexai) {
    if (!isBrowser() && !params.project) {
      params.project = process.env['GOOGLE_CLOUD_PROJECT'];
    }
    if (!isBrowser() && !params.location) {
      params.location = process.env['GOOGLE_CLOUD_LOCATION'];
    }
    if (!params.project) {
      throw new Error(
        'VertexAI project must be provided via constructor or GOOGLE_CLOUD_PROJECT environment variable.',
      );
    }
    if (!params.location) {
      throw new Error(
        'VertexAI location must be provided via constructor or GOOGLE_CLOUD_LOCATION environment variable.',
      );
    }
  } else {
    if (!params.apiKey && !isBrowser()) {
      // `GOOGLE_API_KEY` before `GEMINI_API_KEY`, matching @google/genai's own
      // `getApiKeyFromEnv()` and adk-python, which leaves the choice to the SDK
      // entirely. Resolving the key here shadows the SDK, so an order that
      // disagrees with it makes its "Both GOOGLE_API_KEY and GEMINI_API_KEY are
      // set. Using GOOGLE_API_KEY." warning describe a key adk-js did not use.
      //
      // `GOOGLE_GENAI_API_KEY` stays first: no SDK understands that name, and
      // `adk create` writes it into every scaffolded .env, so it is the
      // adk-js-specific override.
      params.apiKey =
        process.env['GOOGLE_GENAI_API_KEY'] ||
        process.env['GOOGLE_API_KEY'] ||
        process.env['GEMINI_API_KEY'];
    }
  }
  return params;
}
