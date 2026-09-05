/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FinishReason,
  GroundingMetadata,
  HttpOptions,
  Part,
} from '@google/genai';

import {ContextCacheConfig} from '../agents/context_cache_config.js';
import {mergeTrackingHeaders} from '../utils/client_labels.js';
import {logger} from '../utils/logger.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {FetchLiteLlmClient, LiteLlmClient} from './lite_llm_client.js';
import {
  isLiteLlmGeminiModel,
  isLiteLlmVertexModel,
  mapFinishReason,
} from './lite_llm_model_utils.js';
import {
  appendFallbackUserContentIfMissing,
  buildRequestLog,
  CompletionInputs,
  getCompletionInputs,
} from './lite_llm_request_converters.js';
import {
  applyFinishReason,
  BraceDepthTracker,
  extractGroundingMetadata,
  LiteLlmUsageMetadata,
  messageToGenerateContentResponse,
  modelResponseToChunks,
  modelResponseToGenerateContentResponse,
  parseToolCallArguments,
} from './lite_llm_response_converters.js';
import {
  CacheControl,
  CacheControlInjectionPoint,
  CompletionArgs,
  ToolCall,
} from './lite_llm_types.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';
import {resolveCacheConfig, useOneHourTtl} from './prompt_cache.js';

/**
 * Keys a caller may not set through `additionalArgs`: the class owns them, and
 * letting them through would send a request that contradicts itself.
 */
const RESERVED_ARGUMENT_KEYS = ['model', 'messages', 'tools', 'stream'];

/** The error reported when a stream truncates a tool call mid-argument. */
const TRUNCATED_TOOL_CALL_MESSAGE =
  'Tool call arguments were truncated while streaming and could not be ' +
  'parsed as valid JSON. Increase `max_output_tokens` and retry.';

/** Milliseconds per second, for the `HttpOptions.timeout` conversion. */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * Describes the prefix LiteLLM should mark as cacheable.
 *
 * LiteLLM applies these itself and then lets each provider decide what to do
 * with them, so the same two points are correct whatever the model turns out
 * to be: a provider that caches by marked prefix, such as Claude, honours
 * them, and a provider that caches automatically or not at all has them
 * dropped before the request leaves.
 *
 * The system instruction is one point because it is the stable head of the
 * prompt. The final message is the other, which caches the conversation so far
 * and moves forward on its own as the conversation grows. Tool definitions get
 * no point of their own, because LiteLLM's only tool-level location is
 * specific to one provider.
 */
function cacheControlInjectionPoints(
  cacheConfig: ContextCacheConfig,
): CacheControlInjectionPoint[] {
  const control: CacheControl = {type: 'ephemeral'};
  if (useOneHourTtl(cacheConfig)) {
    control.ttl = '1h';
  }
  return [
    {location: 'message', role: 'system', control},
    {location: 'message', index: -1, control},
  ];
}

/** Folds the request's `HttpOptions` into the request body. */
function applyHttpOptions(args: CompletionArgs, httpOptions: HttpOptions) {
  if (httpOptions.headers) {
    args.extra_headers = {...args.extra_headers, ...httpOptions.headers};
  }
  if (httpOptions.timeout !== undefined) {
    // HttpOptions.timeout is milliseconds; the wire field is seconds.
    args.timeout = httpOptions.timeout / MILLISECONDS_PER_SECOND;
  }
  if (httpOptions.retryOptions?.attempts !== undefined) {
    args.num_retries = httpOptions.retryOptions.attempts;
  }
  if (httpOptions.extraBody !== undefined) {
    args.extra_body = httpOptions.extraBody;
  }
}

/** Constructor parameters for {@link LiteLlm}. */
export interface LiteLlmParams {
  /**
   * The model name, sent verbatim. LiteLLM's `provider/model` form, for
   * example `anthropic/claude-sonnet-4`.
   */
  model: string;
  /**
   * The endpoint base URL. Read by the built-in client only, which falls back
   * to the `LITELLM_API_BASE` environment variable.
   */
  apiBase?: string;
  /**
   * The API key, sent as a bearer token. Read by the built-in client only,
   * which falls back to the `LITELLM_API_KEY` environment variable.
   */
  apiKey?: string;
  /**
   * Extra HTTP headers. The built-in client sends them on every request, and a
   * Vertex AI or Gemini model merges them with ADK's tracking headers.
   */
  headers?: Record<string, string>;
  /** The transport to send requests through. Defaults to the built-in one. */
  client?: LiteLlmClient;
  /**
   * Extra completion arguments merged over the generated request, for example
   * `{temperature: 0.2}`. The keys the class owns are dropped.
   */
  additionalArgs?: Record<string, unknown>;
}

/** One tool call being assembled from streamed fragments. */
interface StreamingToolCall {
  /** Defaults to the call's index, which is what a provider that sends no id
   * leaves us to key the call by. */
  id: string;
  name: string;
  argsParts: string[];
}

/**
 * A model served over the OpenAI chat-completions protocol.
 *
 * This is how an ADK agent runs on a non-Gemini model: OpenAI, Anthropic,
 * Azure, Bedrock, Groq, Mistral, DeepSeek, Ollama, vLLM and anything else
 * behind a LiteLLM Proxy deployment. The provider routing lives in the
 * endpoint, not here, so the endpoint decides which models are reachable.
 *
 * An instance must be constructed explicitly: {@link supportedModels} declares
 * the provider prefixes this class handles, but `LiteLlm` is deliberately not
 * registered with `LLMRegistry`, which would construct it from a model string
 * alone and leave it with no endpoint to call.
 *
 * @example
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'assistant',
 *   model: new LiteLlm({
 *     model: 'anthropic/claude-sonnet-4',
 *     apiBase: 'http://localhost:4000/v1',
 *     apiKey: process.env['LITELLM_API_KEY'],
 *     additionalArgs: {temperature: 0.2},
 *   }),
 *   instruction: 'You are a helpful assistant.',
 * });
 * ```
 */
export class LiteLlm extends BaseLlm {
  private readonly client: LiteLlmClient;
  private readonly additionalArgs: Record<string, unknown>;
  private readonly headers?: Record<string, string>;

  /**
   * Provider prefixes this class handles. See
   * https://docs.litellm.ai/docs/providers for the full provider list; a
   * LiteLLM Proxy reaches models beyond these prefixes too.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /openai\/.*/,
    /azure\/.*/,
    /azure_ai\/.*/,
    /groq\/.*/,
    /anthropic\/.*/,
    /bedrock\/.*/,
    /ollama\/(?!gemma3).*/,
    /ollama_chat\/.*/,
    /together_ai\/.*/,
    /vertex_ai\/.*/,
    /mistral\/.*/,
    /deepseek\/.*/,
    /fireworks_ai\/.*/,
    /cohere\/.*/,
    /databricks\/.*/,
    /ai21\/.*/,
  ];

  constructor({
    model,
    apiBase,
    apiKey,
    headers,
    client,
    additionalArgs,
  }: LiteLlmParams) {
    super({model});
    this.client = client ?? new FetchLiteLlmClient({apiBase, apiKey, headers});
    this.headers = headers;
    const scrubbed = {...additionalArgs};
    for (const key of RESERVED_ARGUMENT_KEYS) {
      delete scrubbed[key];
    }
    this.additionalArgs = scrubbed;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.maybeAppendUserContent(llmRequest);
    appendFallbackUserContentIfMissing(llmRequest);
    logger.debug(buildRequestLog(llmRequest));

    const effectiveModel = llmRequest.model ?? this.model;
    const inputs = getCompletionInputs(llmRequest, effectiveModel);
    const args = this.buildCompletionArgs(effectiveModel, inputs, llmRequest);

    if (!stream) {
      const response = await this.client.completion(args, abortSignal);
      yield modelResponseToGenerateContentResponse(response);
      return;
    }

    args.stream = true;
    args.stream_options = {include_usage: true};
    yield* this.streamResponses(args, abortSignal);
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error(`Live connection is not supported for ${this.model}.`);
  }

  /** Assembles the request body from the converted inputs and the options. */
  private buildCompletionArgs(
    model: string,
    inputs: CompletionInputs,
    llmRequest: LlmRequest,
  ): CompletionArgs {
    const args: CompletionArgs = {
      model,
      messages: inputs.messages,
      tools: inputs.tools,
      response_format: inputs.responseFormat,
      ...this.additionalArgs,
      ...inputs.generationParams,
    };
    if (inputs.toolChoice !== undefined) {
      args.tool_choice = inputs.toolChoice;
    }

    // A caller who named their own injection points through `additionalArgs`
    // has said more about their provider than the app-level config can, so
    // leave those alone.
    const cacheConfig = resolveCacheConfig(llmRequest);
    if (cacheConfig && args.cache_control_injection_points === undefined) {
      args.cache_control_injection_points =
        cacheControlInjectionPoints(cacheConfig);
    }

    const httpOptions = llmRequest.config?.httpOptions;
    if (httpOptions) {
      applyHttpOptions(args, httpOptions);
    }

    // Vertex AI and Gemini endpoints attribute the call to ADK. Every other
    // provider is sent nothing. This is the `headers` request parameter, which
    // LiteLLM passes to the provider; `extra_headers` would stop at the
    // endpoint this request is sent to. It runs last, so a caller's own header
    // value is present to de-duplicate against.
    if (isLiteLlmVertexModel(model) || isLiteLlmGeminiModel(model)) {
      args.headers = mergeTrackingHeaders({
        ...this.headers,
        ...args.headers,
      });
    }
    return args;
  }

  /**
   * Streams a completion: a partial response per text or reasoning delta, then
   * the aggregated response or responses.
   */
  private async *streamResponses(
    args: CompletionArgs,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    let textParts: string[] = [];
    let reasoningParts: Part[] = [];
    const functionCalls = new Map<number, StreamingToolCall>();
    const toolCallTrackers = new Map<number, BraceDepthTracker>();
    let aggregatedResponse: LlmResponse | undefined;
    let aggregatedToolCallResponse: LlmResponse | undefined;
    let usageMetadata: LiteLlmUsageMetadata | undefined;
    let groundingMetadata: GroundingMetadata | undefined;
    let lastFinishReason: string | undefined;
    let modelVersion: string | undefined;
    let fallbackIndex = 0;

    const resetBuffers = () => {
      textParts = [];
      reasoningParts = [];
      functionCalls.clear();
      toolCallTrackers.clear();
      // The reason belongs to the segment just finalized; carrying it forward
      // would stamp the wrong reason on the next one.
      lastFinishReason = undefined;
    };

    const finalizeToolCallResponse = (finishReason: string): LlmResponse => {
      const toolCalls: ToolCall[] = [];
      let truncated = false;
      for (const [index, call] of functionCalls) {
        const args = call.argsParts.join('');
        if (finishReason === 'length') {
          try {
            parseToolCallArguments(args);
          } catch {
            truncated = true;
            continue;
          }
        }
        toolCalls.push({
          type: 'function',
          id: call.id,
          function: {name: call.name, arguments: args},
          index,
        });
      }
      if (truncated) {
        return {
          errorCode: FinishReason.MAX_TOKENS,
          errorMessage: TRUNCATED_TOOL_CALL_MESSAGE,
          finishReason: FinishReason.MAX_TOKENS,
          modelVersion,
        };
      }
      const response = messageToGenerateContentResponse(
        {role: 'assistant', content: textParts.join(''), tool_calls: toolCalls},
        {modelVersion, thoughtParts: reasoningParts},
      );
      applyFinishReason(response, finishReason);
      return response;
    };

    const finalizeTextResponse = (finishReason: string): LlmResponse => {
      const response = messageToGenerateContentResponse(
        {role: 'assistant', content: textParts.join('') || null},
        {modelVersion, thoughtParts: reasoningParts},
      );
      applyFinishReason(response, finishReason);
      return response;
    };

    for await (const chunk of await this.client.streamCompletion(
      args,
      abortSignal,
    )) {
      modelVersion = chunk.model ?? modelVersion;
      // Grounding metadata arrives on the first chunk (search queries) or the
      // last one (supports); keep the latest non-empty one.
      const chunkGrounding = extractGroundingMetadata(chunk);
      if (chunkGrounding) {
        groundingMetadata = chunkGrounding;
      }

      for (const [piece, finishReason] of modelResponseToChunks(chunk)) {
        if (finishReason) {
          lastFinishReason = finishReason;
        }
        switch (piece?.kind) {
          case 'function': {
            // An index of 0 falls back too: providers that mis-index parallel
            // tool calls send 0 for every one of them.
            const index = piece.index || fallbackIndex;
            let call = functionCalls.get(index);
            if (!call) {
              call = {id: String(index), name: '', argsParts: []};
              functionCalls.set(index, call);
            }
            if (piece.name) {
              call.name += piece.name;
            }
            if (piece.args) {
              call.argsParts.push(piece.args);
              let tracker = toolCallTrackers.get(index);
              if (!tracker) {
                tracker = new BraceDepthTracker();
                toolCallTrackers.set(index, tracker);
              }
              if (tracker.feed(piece.args)) {
                try {
                  JSON.parse(call.argsParts.join(''));
                  fallbackIndex++;
                } catch {
                  // The object closed but the payload is still incomplete.
                }
              }
            }
            call.id = piece.id || call.id;
            break;
          }
          case 'text':
            textParts.push(piece.text);
            yield messageToGenerateContentResponse(
              {role: 'assistant', content: piece.text},
              {isPartial: true, modelVersion: chunk.model},
            );
            break;
          case 'reasoning':
            reasoningParts.push(...piece.parts);
            yield {
              content: {role: 'model', parts: [...piece.parts]},
              partial: true,
              modelVersion: chunk.model,
            };
            break;
          case 'usage':
            usageMetadata = piece.usage;
            break;
          default:
            break;
        }

        // A provider can set finish_reason="stop" on a chunk that still
        // carries content, so only a content-free stop ends a segment.
        if (
          functionCalls.size > 0 &&
          (finishReason === 'tool_calls' ||
            finishReason === 'length' ||
            (finishReason === 'stop' && !piece))
        ) {
          aggregatedToolCallResponse = finalizeToolCallResponse(finishReason);
          resetBuffers();
        } else if (
          (textParts.length > 0 || reasoningParts.length > 0) &&
          (finishReason === 'length' ||
            (finishReason === 'stop' && !piece && functionCalls.size === 0))
        ) {
          aggregatedResponse = finalizeTextResponse(finishReason);
          resetBuffers();
        }
      }
    }

    // Only the reasons known to end a stream finalize in the loop, so any
    // other terminal reason arrives here with the buffers still full.
    if (functionCalls.size > 0 && !aggregatedToolCallResponse) {
      aggregatedToolCallResponse = finalizeToolCallResponse(
        lastFinishReason ?? 'tool_calls',
      );
      resetBuffers();
    }
    if (
      (textParts.length > 0 || reasoningParts.length > 0) &&
      !aggregatedResponse
    ) {
      aggregatedResponse = finalizeTextResponse(lastFinishReason ?? 'stop');
      resetBuffers();
    } else if (
      lastFinishReason &&
      !aggregatedResponse &&
      !aggregatedToolCallResponse
    ) {
      // The stream ended without producing content: a content filter, or
      // truncation before the first token. Report it the way the
      // non-streaming path does rather than yielding nothing at all.
      const mapped = mapFinishReason(lastFinishReason);
      if (mapped && mapped !== FinishReason.STOP) {
        aggregatedResponse = finalizeTextResponse(lastFinishReason);
      }
    }

    if (aggregatedResponse) {
      if (usageMetadata) {
        aggregatedResponse.usageMetadata = usageMetadata;
        usageMetadata = undefined;
      }
      if (groundingMetadata) {
        aggregatedResponse.groundingMetadata = groundingMetadata;
      }
      yield aggregatedResponse;
    }
    if (aggregatedToolCallResponse) {
      if (usageMetadata) {
        aggregatedToolCallResponse.usageMetadata = usageMetadata;
      }
      if (groundingMetadata) {
        aggregatedToolCallResponse.groundingMetadata = groundingMetadata;
      }
      yield aggregatedToolCallResponse;
    }
  }
}
