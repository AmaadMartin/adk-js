/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApiError,
  Blob,
  createPartFromText,
  FileData,
  GoogleGenAI,
  GoogleGenAIOptions,
  HttpOptions,
  HttpRetryOptions,
  LiveServerMessage,
  SpeechConfig,
  ToolListUnion,
} from '@google/genai';

import {normalizeBaseUrlAndApiVersion} from '../utils/base_url_utils.js';
import {mergeTrackingHeaders} from '../utils/client_labels.js';
import {isBrowser, isEnterpriseModeEnabled} from '../utils/env_aware_utils.js';
import {isHttpStatusError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {asSafePartForLlm} from '../utils/safe_part_utils.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

import {AsyncQueue} from '../utils/async_queue.js';
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
   * A pre-configured google-genai client. When set it serves every API call,
   * and none of the fields that build a client are used.
   */
  client?: GoogleGenAI;
  /**
   * Extra options merged over the ones ADK passes to the `GoogleGenAI`
   * constructor. Named after adk-python's `client_kwargs` so the same
   * configuration is recognisable in both SDKs.
   */
  clientKwargs?: GoogleGenAIOptions;
  /**
   * The base URL for the AI platform service endpoint.
   *
   * An API version in the path of a `*.googleapis.com` URL, such as a trailing
   * `/v1alpha`, is read as {@link GeminiParams.apiVersion} and takes
   * precedence over that field.
   */
  baseUrl?: string;
  /**
   * The API version for the AI platform service endpoint.
   *
   * For the Vertex AI backend the google-genai SDK defaults to `v1beta1`,
   * which exposes preview features. Set `v1` for the stable, SLA-eligible
   * endpoint. When unset, the `GOOGLE_GENAI_API_VERSION` environment variable
   * is consulted, and finally the SDK's own default applies.
   */
  apiVersion?: string;
  /**
   * Retry options for the SDK's HTTP layer, e.g. `{attempts: 2}`.
   */
  retryOptions?: HttpRetryOptions;
  /**
   * The speech config applied to a live (bidi) connection. It overrides a
   * speech config already on the request.
   */
  speechConfig?: SpeechConfig;
}

const GEMINI_MODEL_SYMBOL = Symbol.for('google.adk.geminiModel');

/** Environment variable consulted when no `apiVersion` is configured. */
const API_VERSION_ENV_VARIABLE_NAME = 'GOOGLE_GENAI_API_VERSION';

/** HTTP status the Gemini backends return when a quota is exhausted. */
const RESOURCE_EXHAUSTED_STATUS = 429;

/**
 * Placeholder artifact name for inline data, which carries no filename.
 */
const INLINE_DATA_ARTIFACT_NAME = 'inline-file';

const RESOURCE_EXHAUSTED_POSSIBLE_FIX_MESSAGE = `
On how to mitigate this issue, please refer to:

https://google.github.io/adk-docs/agents/models/google-gemini/#error-code-429-resource_exhausted
`;

/**
 * A quota error from the model, with the mitigation guide in its message.
 *
 * Running out of quota is a common failure, and the raw HTTP 429 says nothing
 * about what to do next, so the documentation link is put where the developer
 * already reads: the error message.
 */
export class ResourceExhaustedError extends ApiError {
  /**
   * @param cause The original error the model API returned.
   */
  constructor(cause: {message: string; status: number}) {
    super({
      message: `${RESOURCE_EXHAUSTED_POSSIBLE_FIX_MESSAGE}\n\n${cause.message}`,
      status: cause.status,
    });
    // `ApiError` pins the prototype to its own, so a subclass has to restore
    // its prototype or `instanceof` reports the base class for every instance.
    Object.setPrototypeOf(this, ResourceExhaustedError.prototype);
    this.name = 'ResourceExhaustedError';
    this.cause = cause;
  }
}

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
  private readonly client?: GoogleGenAI;
  private readonly clientKwargs?: GoogleGenAIOptions;
  private readonly baseUrl?: string;
  private readonly baseUrlApiVersion?: string;
  private readonly apiVersion?: string;
  private readonly retryOptions?: HttpRetryOptions;
  private readonly speechConfig?: SpeechConfig;

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
    client,
    clientKwargs,
    baseUrl,
    apiVersion,
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
    this.client = client;
    this.clientKwargs = clientKwargs;
    this.apiVersion = apiVersion;
    this.retryOptions = retryOptions;
    this.speechConfig = speechConfig;

    const normalized = normalizeBaseUrlAndApiVersion(baseUrl);
    this.baseUrl = normalized.baseUrl;
    this.baseUrlApiVersion = normalized.apiVersion;
  }

  /**
   * A list of model name patterns that are supported by this LLM.
   *
   * @returns A list of supported models.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /gemini-.*/,
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

    // The request's http options override the ones the client was built with,
    // so the tracking headers are merged in even when the caller supplied
    // none. Otherwise a caller's own http options drop them.
    if (!llmRequest.config.httpOptions) {
      llmRequest.config.httpOptions = {};
    }
    llmRequest.config.httpOptions.headers = mergeTrackingHeaders(
      llmRequest.config.httpOptions.headers,
    );
    // The environment variable is deliberately not consulted here: it must not
    // override the version a custom client was built with.
    const apiVersion = this.baseUrlApiVersion ?? this.apiVersion;
    if (apiVersion && !llmRequest.config.httpOptions.apiVersion) {
      llmRequest.config.httpOptions.apiVersion = apiVersion;
    }

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
    } catch (error: unknown) {
      if (
        isHttpStatusError(error) &&
        error.status === RESOURCE_EXHAUSTED_STATUS
      ) {
        throw new ResourceExhaustedError(error);
      }
      throw error;
    }
  }

  /**
   * The API version to send, or `undefined` to leave the SDK's default in
   * place. A version in the base URL wins over the field, which wins over the
   * environment variable.
   */
  private get configuredApiVersion(): string | undefined {
    if (this.baseUrlApiVersion) {
      return this.baseUrlApiVersion;
    }
    if (this.apiVersion) {
      return this.apiVersion;
    }
    return isBrowser()
      ? undefined
      : process.env[API_VERSION_ENV_VARIABLE_NAME] || undefined;
  }

  protected getHttpOptions(): HttpOptions {
    const httpOptions: HttpOptions = {
      headers: {...this.trackingHeaders, ...this.headers},
      baseUrl: this.baseUrl,
      retryOptions: this.retryOptions,
    };
    const apiVersion = this.configuredApiVersion;
    if (apiVersion) {
      httpOptions.apiVersion = apiVersion;
    }
    return httpOptions;
  }

  get apiClient(): GoogleGenAI {
    if (this.client) {
      return this.client;
    }
    if (this._apiClient) {
      return this._apiClient;
    }

    const options: GoogleGenAIOptions = this.vertexai
      ? {
          vertexai: this.vertexai,
          project: this.project,
          location: this.location,
          httpOptions: this.getHttpOptions(),
        }
      : {apiKey: this.apiKey, httpOptions: this.getHttpOptions()};
    this._apiClient = new GoogleGenAI({...options, ...this.clientKwargs});
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
      // A version in the base URL wins. Otherwise Vertex uses the beta API and
      // the AI Studio backend uses v1alpha; the configured `apiVersion` does
      // not apply to the live endpoint.
      this._liveApiVersion =
        this.baseUrlApiVersion ??
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
      baseUrl: this.baseUrl,
    };
  }

  get liveApiClient(): GoogleGenAI {
    if (this.client) {
      return this.client;
    }
    if (!this._liveApiClient) {
      const options: GoogleGenAIOptions = this.vertexai
        ? {
            vertexai: this.vertexai,
            project: this.project,
            location: this.location || 'global',
            httpOptions: this.getLiveHttpOptions(),
          }
        : {apiKey: this.apiKey, httpOptions: this.getLiveHttpOptions()};
      this._liveApiClient = new GoogleGenAI({...options, ...this.clientKwargs});
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
      llmRequest.liveConnectConfig.httpOptions.headers = mergeTrackingHeaders(
        llmRequest.liveConnectConfig.httpOptions.headers,
      );
      llmRequest.liveConnectConfig.httpOptions.apiVersion = this.liveApiVersion;
    }

    if (this.speechConfig !== undefined) {
      llmRequest.liveConnectConfig.speechConfig = this.speechConfig;
    }

    if (llmRequest.config?.systemInstruction) {
      llmRequest.liveConnectConfig.systemInstruction = {
        role: 'system',
        // TODO - b/425992518: validate type casting works well.
        parts: [
          createPartFromText(llmRequest.config.systemInstruction as string),
        ],
      };
    }

    llmRequest.liveConnectConfig.tools = llmRequest.config?.tools;

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

    if (llmRequest.config && hasComputerUseTool(llmRequest.config.tools)) {
      // Computer use ignores a system instruction; the wait-tool swap lands
      // with the computer-use toolset port.
      llmRequest.config.systemInstruction = undefined;
    }

    if (llmRequest.contents) {
      for (const content of llmRequest.contents) {
        if (!content.parts) continue;
        content.parts = content.parts.map((part) =>
          part.inlineData
            ? asSafePartForLlm(part, INLINE_DATA_ARTIFACT_NAME)
            : part,
        );
      }
    }
  }
}

/** Whether the request drives the model's computer-use mode. */
function hasComputerUseTool(tools: ToolListUnion | undefined): boolean {
  return !!tools?.some((tool) => 'computerUse' in tool && !!tool.computerUse);
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
