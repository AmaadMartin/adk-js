/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic, BaseAnthropic} from '@anthropic-ai/sdk';
import {FunctionDeclaration, Part, Tool} from '@google/genai';

import {logger} from '../utils/logger.js';
import {loadOptionalPeer, OptionalPeer} from '../utils/optional_peer.js';

import {
  AnthropicEffort,
  AnthropicGenerateContentConfig,
  buildEffortParam,
  buildThinkingParam,
} from './anthropic_config.js';
import {
  AnthropicTokenCounts,
  buildUsageMetadata,
  contentBlockToPart,
  contentToMessageParam,
  extractThinkingTokenCount,
  extractTokenCounts,
  functionDeclarationToToolParam,
  messageToLlmResponse,
  toGoogleGenAiFinishReason,
  ToolUseIdSanitizer,
} from './anthropic_converters.js';
import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {extractSystemInstruction} from './interactions_utils.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/** The optional peer backing {@link AnthropicLlm}. */
const ANTHROPIC_SDK: OptionalPeer = {
  packageName: '@anthropic-ai/sdk',
  feature: 'AnthropicLlm (Claude via the Anthropic API)',
};

/** The optional peer backing {@link Claude}. */
const ANTHROPIC_VERTEX_SDK: OptionalPeer = {
  packageName: '@anthropic-ai/vertex-sdk',
  feature: 'Claude (Claude served from Vertex AI)',
};

/** Default model for the Anthropic API. */
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

/** Default model for Claude served from Vertex AI. */
const DEFAULT_VERTEX_CLAUDE_MODEL = 'claude-3-5-sonnet-v2@20241022';

/** Default `max_tokens`, which the Anthropic API requires on every request. */
const DEFAULT_MAX_TOKENS = 8192;

const RATE_LIMIT_POSSIBLE_FIX_MESSAGE =
  'On how to mitigate this issue, please refer to:\n\n' +
  'https://docs.anthropic.com/en/api/errors#http-errors';

const HTTP_TOO_MANY_REQUESTS = 429;

/** Pulls the model id out of a full Vertex AI resource name. */
const VERTEX_MODEL_RESOURCE_NAME =
  /projects\/[^/]+\/locations\/[^/]+\/(?:publishers\/anthropic\/models|endpoints)\/([^/:]+)/;

/** Pulls the project and the region out of a full Vertex AI resource name. */
const VERTEX_PROJECT_AND_LOCATION = /projects\/([^/]+)\/locations\/([^/]+)\//;

/**
 * The Anthropic client surface ADK uses.
 *
 * Both `Anthropic` and `AnthropicVertex` satisfy it structurally. Declaring
 * the surface, rather than naming the two concrete classes, keeps the streamed
 * result an `AsyncIterable` and lets a caller inject any client that
 * implements it.
 */
export interface AnthropicClient {
  readonly apiKey: BaseAnthropic['apiKey'];
  readonly authToken: BaseAnthropic['authToken'];
  readonly credentials: BaseAnthropic['credentials'];
  readonly messages: AnthropicMessages;
}

/** The `messages` resource of an {@link AnthropicClient}. */
export interface AnthropicMessages {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: AnthropicRequestOptions,
  ): Promise<Anthropic.Message>;
  create(
    params: Anthropic.MessageCreateParamsStreaming,
    options?: AnthropicRequestOptions,
  ): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>>;
}

/** The per-request options ADK passes to the Anthropic client. */
export interface AnthropicRequestOptions {
  signal?: AbortSignal;
}

/** Constructor parameters for {@link AnthropicLlm} and {@link Claude}. */
export interface AnthropicLlmParams {
  /**
   * The Claude model to call. Defaults to `claude-sonnet-4-20250514` for
   * {@link AnthropicLlm} and `claude-3-5-sonnet-v2@20241022` for
   * {@link Claude}.
   */
  model?: string;
  /** Upper bound on generated tokens when the request does not set one. */
  maxTokens?: number;
  /** A pre-configured client. Skips credential resolution entirely. */
  client?: AnthropicClient;
}

/**
 * Raised when Anthropic rejects a request for exceeding a rate limit.
 *
 * Carries the original SDK error as `cause` and prefixes its message with the
 * documentation that explains how to raise the limit.
 */
export class AnthropicRateLimitError extends Error {
  constructor(cause: Error) {
    super(`${RATE_LIMIT_POSSIBLE_FIX_MESSAGE}\n\n${cause.message}`, {cause});
    this.name = 'AnthropicRateLimitError';
  }
}

/**
 * Recognises the SDK's rate-limit error by its HTTP status.
 *
 * The class is reached through a dynamic import, so two copies of the SDK in
 * one runtime would make an `instanceof` check silently false. The status is
 * the same in both copies.
 */
function isRateLimitError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    'status' in err &&
    err.status === HTTP_TOO_MANY_REQUESTS
  );
}

/** A Vertex-backed Anthropic client, which carries its project and region. */
interface VertexAnthropicClient extends AnthropicClient {
  readonly region: string;
  readonly projectId: string | null;
}

function isVertexAnthropicClient(
  client: AnthropicClient,
): client is VertexAnthropicClient {
  return 'region' in client && 'projectId' in client;
}

/** Streamed state of one `tool_use` content block. */
interface ToolUseAccumulator {
  id: string;
  name: string;
  argsJson: string;
}

/** Streamed state of one `thinking` content block. */
interface ThinkingAccumulator {
  thinking: string;
  signature: string;
}

/**
 * Collects streamed content blocks by index and assembles the final parts.
 *
 * Claude interleaves the blocks of one turn, addressing each by index, so the
 * deltas have to be gathered per index and only ordered at the end.
 */
class StreamedContentBlocks {
  private readonly texts = new Map<number, string>();
  private readonly toolUses = new Map<number, ToolUseAccumulator>();
  private readonly thinking = new Map<number, ThinkingAccumulator>();
  private readonly redactedThinking = new Map<number, string>();

  start(index: number, block: Anthropic.ContentBlock): void {
    switch (block.type) {
      case 'thinking':
        this.thinking.set(index, {
          thinking: block.thinking,
          signature: block.signature,
        });
        break;
      case 'redacted_thinking':
        // A redacted block arrives complete; no deltas follow it.
        this.redactedThinking.set(index, block.data);
        break;
      case 'text':
        this.texts.set(index, block.text);
        break;
      case 'tool_use':
        this.toolUses.set(index, {
          id: block.id,
          name: block.name,
          argsJson: '',
        });
        break;
      default:
        break;
    }
  }

  appendThinking(index: number, thinking: string): void {
    const accumulator = this.thinkingAt(index);
    accumulator.thinking += thinking;
  }

  appendSignature(index: number, signature: string): void {
    const accumulator = this.thinkingAt(index);
    accumulator.signature += signature;
  }

  appendText(index: number, text: string): void {
    this.texts.set(index, (this.texts.get(index) ?? '') + text);
  }

  appendToolArgs(index: number, partialJson: string): void {
    const accumulator = this.toolUses.get(index);
    if (accumulator) {
      accumulator.argsJson += partialJson;
    }
  }

  /** Returns the accumulated parts in ascending block index. */
  toParts(): Part[] {
    const indices = new Set([
      ...this.thinking.keys(),
      ...this.redactedThinking.keys(),
      ...this.texts.keys(),
      ...this.toolUses.keys(),
    ]);
    const parts: Part[] = [];
    for (const index of [...indices].sort((a, b) => a - b)) {
      const thinking = this.thinking.get(index);
      if (thinking) {
        parts.push(
          contentBlockToPart({
            type: 'thinking',
            thinking: thinking.thinking,
            signature: thinking.signature,
          }),
        );
      }
      const redacted = this.redactedThinking.get(index);
      if (redacted !== undefined) {
        parts.push(
          contentBlockToPart({type: 'redacted_thinking', data: redacted}),
        );
      }
      const text = this.texts.get(index);
      if (text !== undefined) {
        parts.push({text});
      }
      const toolUse = this.toolUses.get(index);
      if (toolUse) {
        parts.push({
          functionCall: {
            id: toolUse.id,
            name: toolUse.name,
            args: toolUse.argsJson ? JSON.parse(toolUse.argsJson) : {},
          },
        });
      }
    }
    return parts;
  }

  private thinkingAt(index: number): ThinkingAccumulator {
    let accumulator = this.thinking.get(index);
    if (!accumulator) {
      accumulator = {thinking: '', signature: ''};
      this.thinking.set(index, accumulator);
    }
    return accumulator;
  }
}

/** Wraps one streamed chunk as a partial response. */
function partialResponse(part: Part): LlmResponse {
  return {content: {role: 'model', parts: [part]}, partial: true};
}

/**
 * Records one content-block delta and yields whatever the caller should see.
 *
 * A signature delta yields nothing: the signature is opaque rather than
 * user-visible text. It still has to be accumulated, because a thinking block
 * that reaches the next turn unsigned makes Claude reject the request.
 */
function* contentBlockDeltaResponses(
  blocks: StreamedContentBlocks,
  event: Anthropic.RawContentBlockDeltaEvent,
): Generator<LlmResponse> {
  const {delta, index} = event;
  switch (delta.type) {
    case 'thinking_delta':
      blocks.appendThinking(index, delta.thinking);
      yield partialResponse({text: delta.thinking, thought: true});
      break;
    case 'signature_delta':
      blocks.appendSignature(index, delta.signature);
      break;
    case 'text_delta':
      blocks.appendText(index, delta.text);
      yield partialResponse({text: delta.text});
      break;
    case 'input_json_delta':
      blocks.appendToolArgs(index, delta.partial_json);
      break;
    default:
      break;
  }
}

/**
 * Turns Anthropic's event stream into partial responses plus a final one.
 *
 * @param events The raw stream Anthropic returned.
 * @return Each chunk as it arrives, then one aggregated response.
 */
async function* streamResponses(
  events: AsyncIterable<Anthropic.RawMessageStreamEvent>,
): AsyncGenerator<LlmResponse, void> {
  const blocks = new StreamedContentBlocks();
  let counts: AnthropicTokenCounts = {promptTokens: 0, outputTokens: 0};
  let stopReason: Anthropic.StopReason | undefined;

  for await (const event of events) {
    switch (event.type) {
      case 'message_start':
        counts = extractTokenCounts(event.message.usage);
        break;
      case 'content_block_start':
        blocks.start(event.index, event.content_block);
        break;
      case 'content_block_delta':
        yield* contentBlockDeltaResponses(blocks, event);
        break;
      case 'message_delta':
        // The message delta carries the authoritative cumulative counts, so
        // the thinking detail is refreshed alongside the total it sits in.
        counts.outputTokens = event.usage.output_tokens;
        counts.thinkingTokens = extractThinkingTokenCount(event.usage);
        stopReason = event.delta.stop_reason ?? stopReason;
        break;
      default:
        break;
    }
  }

  yield {
    content: {role: 'model', parts: blocks.toParts()},
    usageMetadata: buildUsageMetadata(counts),
    finishReason: toGoogleGenAiFinishReason(stopReason),
    partial: false,
  };
}

/**
 * Adds the sampling parameters to the request, unless Claude would reject
 * them.
 *
 * Models after Claude Opus 4.6 refuse `temperature`, `top_p` and `top_k` when
 * thinking or an effort level is set, so they are dropped with one warning.
 */
function applySamplingParams(
  params: Anthropic.MessageCreateParamsNonStreaming,
  config: AnthropicGenerateContentConfig | undefined,
  thinking: Anthropic.ThinkingConfigParam | undefined,
  effort: AnthropicEffort | undefined,
): void {
  if (!config) {
    return;
  }
  const excludeSampling =
    thinking?.type === 'enabled' ||
    thinking?.type === 'adaptive' ||
    effort !== undefined;
  if (excludeSampling) {
    if (
      config.temperature !== undefined ||
      config.topP !== undefined ||
      config.topK !== undefined
    ) {
      logger.warn(
        'Sampling parameters (temperature, top_p, top_k) are ignored because ' +
          'thinking/effort is enabled.',
      );
    }
    return;
  }
  if (config.temperature !== undefined) {
    params.temperature = config.temperature;
  }
  if (config.topP !== undefined) {
    params.top_p = config.topP;
  }
  if (config.topK !== undefined) {
    params.top_k = Math.trunc(config.topK);
  }
}

/** Collects the function declarations of every tool configured on a request. */
function collectFunctionDeclarations(
  tools?: Array<Tool | object>,
): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];
  for (const tool of tools ?? []) {
    if ('functionDeclarations' in tool && tool.functionDeclarations) {
      declarations.push(...tool.functionDeclarations);
    }
  }
  return declarations;
}

/**
 * Claude through the Anthropic API.
 *
 * The credential is whatever `@anthropic-ai/sdk` resolves: `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN`, or a provider it discovers from the environment or
 * from the on-disk Anthropic configuration.
 *
 * Reasoning depth is configured with
 * {@link AnthropicGenerateContentConfig.effort}, not with genai's
 * `thinkingConfig.thinkingLevel`: Claude offers five effort levels and
 * `ThinkingLevel` defines four, so the two do not map onto each other.
 *
 * ```ts
 * const llm = new AnthropicLlm({model: 'claude-sonnet-4-20250514'});
 * ```
 */
export class AnthropicLlm extends BaseLlm {
  /** Model name patterns this class serves. */
  static override readonly supportedModels: Array<string | RegExp> = [
    /claude-.*/,
  ];

  /** Upper bound on generated tokens when the request does not set one. */
  readonly maxTokens: number;

  /** The client the caller injected, if any. */
  protected readonly injectedClient?: AnthropicClient;

  private clientPromise?: Promise<AnthropicClient>;

  constructor({model, maxTokens, client}: AnthropicLlmParams = {}) {
    super({model: model ?? DEFAULT_ANTHROPIC_MODEL});
    this.maxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
    this.injectedClient = client;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const params = this.buildRequestParams(llmRequest);
    const client = await this.getClient();
    const options: AnthropicRequestOptions = {signal: abortSignal};
    try {
      if (!stream) {
        yield messageToLlmResponse(
          await client.messages.create(params, options),
        );
        return;
      }
      const events = await client.messages.create(
        {...params, stream: true},
        options,
      );
      yield* streamResponses(events);
    } catch (err: unknown) {
      if (isRateLimitError(err)) {
        throw new AnthropicRateLimitError(err);
      }
      throw err;
    }
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error(`Live connection is not supported for ${this.model}.`);
  }

  /**
   * Returns the Anthropic client, creating it on first use.
   *
   * The promise is memoised, so concurrent requests share one client and one
   * credential resolution.
   */
  protected async getClient(): Promise<AnthropicClient> {
    this.clientPromise ??= this.createClient();
    return this.clientPromise;
  }

  /**
   * Builds the client for this model.
   *
   * The SDK runs its own credential resolution first and is then asked what it
   * found. Enumerating credential sources here would reject setups the SDK
   * handles, such as a signed-in on-disk profile with no environment variable.
   *
   * @throws If the SDK resolved no credential.
   */
  protected async createClient(): Promise<AnthropicClient> {
    if (this.injectedClient) {
      return this.injectedClient;
    }
    const {Anthropic: AnthropicClientClass} = await loadOptionalPeer(
      ANTHROPIC_SDK,
      () => import('@anthropic-ai/sdk'),
    );
    const client = new AnthropicClientClass();
    if (!client.apiKey && !client.authToken && !client.credentials) {
      throw new Error(
        'No Anthropic credential was found for calling Claude through the ' +
          'Anthropic API. Set ANTHROPIC_API_KEY to a key from the Anthropic ' +
          'Console, e.g. `export ANTHROPIC_API_KEY=<your-key>`, or configure ' +
          'any other credential the Anthropic SDK can discover.',
      );
    }
    return client;
  }

  /** Resolves the model id to send, unwrapping a Vertex resource name. */
  protected resolveModelName(model?: string): string {
    if (!model) {
      return this.model;
    }
    return model.match(VERTEX_MODEL_RESOURCE_NAME)?.[1] ?? model;
  }

  /**
   * Assembles the Anthropic request body.
   *
   * The field names are Anthropic's own wire names, so they stay snake_case.
   */
  private buildRequestParams(
    llmRequest: LlmRequest,
  ): Anthropic.MessageCreateParamsNonStreaming {
    const config: AnthropicGenerateContentConfig | undefined =
      llmRequest.config;
    const sanitizer = new ToolUseIdSanitizer();
    const thinking = buildThinkingParam(config);
    const effort = buildEffortParam(config);
    const declarations = collectFunctionDeclarations(config?.tools);

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.resolveModelName(llmRequest.model),
      messages: llmRequest.contents.map((content) =>
        contentToMessageParam(content, sanitizer),
      ),
      max_tokens: config?.maxOutputTokens ?? this.maxTokens,
    };
    const system = extractSystemInstruction(config ?? {});
    if (system) {
      params.system = system;
    }
    if (declarations.length) {
      params.tools = declarations.map(functionDeclarationToToolParam);
    }
    if (Object.keys(llmRequest.toolsDict).length) {
      params.tool_choice = {type: 'auto'};
    }
    if (thinking) {
      params.thinking = thinking;
    }
    if (effort) {
      params.output_config = {effort};
    }
    if (config?.stopSequences?.length) {
      params.stop_sequences = config.stopSequences;
    }
    applySamplingParams(params, config, thinking, effort);
    return params;
  }
}

/**
 * Claude served from Vertex AI.
 *
 * This is the class {@link LLMRegistry} resolves for a `claude-*` model name,
 * so a bare model string reaches Claude through the caller's Google Cloud
 * project. Use {@link AnthropicLlm} to call the Anthropic API directly.
 *
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'assistant',
 *   model: 'claude-3-5-sonnet-v2@20241022',
 * });
 * ```
 */
export class Claude extends AnthropicLlm {
  constructor(params: AnthropicLlmParams = {}) {
    super({...params, model: params.model ?? DEFAULT_VERTEX_CLAUDE_MODEL});
  }

  /**
   * Builds the Vertex AI client for this model.
   *
   * @throws If the project or the region cannot be determined.
   */
  protected override async createClient(): Promise<AnthropicClient> {
    if (this.injectedClient) {
      if (!isVertexAnthropicClient(this.injectedClient)) {
        throw new Error('Claude requires an AnthropicVertex client.');
      }
      return this.injectedClient;
    }
    let projectId = process.env['GOOGLE_CLOUD_PROJECT'];
    let location = process.env['GOOGLE_CLOUD_LOCATION'];
    const resourceName = this.model.match(VERTEX_PROJECT_AND_LOCATION);
    if (resourceName) {
      projectId = resourceName[1];
      location = resourceName[2];
    }
    if (!projectId || !location) {
      throw new Error(
        `Model '${this.model}' resolves to Claude served from Vertex AI, so ` +
          'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set to the ' +
          'project and region serving the model. To call the Anthropic API ' +
          'directly with an ANTHROPIC_API_KEY instead, pass a model instance ' +
          'configured for the Anthropic API rather than a bare model name.',
      );
    }
    const {AnthropicVertex} = await loadOptionalPeer(
      ANTHROPIC_VERTEX_SDK,
      () => import('@anthropic-ai/vertex-sdk'),
    );
    return new AnthropicVertex({
      projectId,
      region: location,
      defaultHeaders: this.trackingHeaders,
    });
  }
}
