/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import {FunctionDeclaration, Part, Tool} from '@google/genai';

import {isRecord, safeJsonLoads} from '../utils/json_utils.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer, OptionalPeer} from '../utils/optional_peer.js';

import {applyCacheBreakpoints} from './anthropic_cache.js';
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
import {resolveCacheConfig} from './prompt_cache.js';

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

/**
 * The start of the message the Anthropic SDK raises when it resolved no
 * credential at all. The SDK raises a plain `Error` here, so its message is
 * the only public signal.
 */
const SDK_NO_CREDENTIAL_MESSAGE = 'Could not resolve authentication method';

const NO_CREDENTIAL_HINT =
  'No Anthropic credential was found for calling Claude through the ' +
  'Anthropic API. Set ANTHROPIC_API_KEY to a key from the Anthropic ' +
  'Console, e.g. `export ANTHROPIC_API_KEY=<your-key>`, or configure any ' +
  'other credential the Anthropic SDK can discover.';

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
  /** A pre-configured client. Skips the SDK's credential resolution. */
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

/**
 * Raised when the Anthropic SDK found no credential for the request.
 *
 * The SDK resolves a credential asynchronously, from an environment variable
 * or from the on-disk Anthropic configuration, and only reports the outcome
 * when a request is made. So the failure is translated here rather than
 * predicted at construction, which would reject a signed-in profile that has
 * no environment variable set.
 */
export class AnthropicCredentialError extends Error {
  constructor(cause: Error) {
    super(`${NO_CREDENTIAL_HINT}\n\n${cause.message}`, {cause});
    this.name = 'AnthropicCredentialError';
  }
}

function isMissingCredentialError(err: unknown): err is Error {
  return (
    err instanceof Error && err.message.startsWith(SDK_NO_CREDENTIAL_MESSAGE)
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

/**
 * The accumulated state of one streamed content block.
 *
 * Claude addresses each block of a turn by index and one index carries exactly
 * one block type, so the discriminant here mirrors the block type it came
 * from.
 */
type StreamedBlock =
  | {type: 'thinking'; thinking: string; signature: string}
  | {type: 'redacted_thinking'; data: string}
  | {type: 'text'; text: string}
  | {type: 'tool_use'; id: string; name: string; argsJson: string};

function streamedBlockToPart(block: StreamedBlock): Part {
  switch (block.type) {
    case 'thinking':
      return contentBlockToPart({
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      });
    case 'redacted_thinking':
      return contentBlockToPart({type: 'redacted_thinking', data: block.data});
    case 'text':
      return {text: block.text};
    case 'tool_use':
      return {
        functionCall: {
          id: block.id,
          name: block.name,
          args: streamedToolArgs(block.argsJson, block.name),
        },
      };
  }
}

/**
 * Decodes the arguments Claude streamed for one tool call.
 *
 * A truncated or non-object argument payload is rejected rather than degraded
 * to `{}`, because an empty argument object is a valid call the tool would
 * then run with the wrong input.
 *
 * @throws If the accumulated text is not a JSON object.
 */
function streamedToolArgs(
  argsJson: string,
  toolName: string,
): Record<string, unknown> {
  if (!argsJson) {
    return {};
  }
  const context = `streamed arguments for tool ${toolName}`;
  const parsed = safeJsonLoads(argsJson, context);
  if (!isRecord(parsed)) {
    throw new Error(`Expected a JSON object for ${context}.`);
  }
  return parsed;
}

/**
 * Collects streamed content blocks by index and assembles the final parts.
 *
 * Claude interleaves the blocks of one turn, addressing each by index, so the
 * deltas have to be gathered per index and only ordered at the end.
 */
class StreamedContentBlocks {
  private readonly blocks = new Map<number, StreamedBlock>();

  start(index: number, block: Anthropic.ContentBlock): void {
    switch (block.type) {
      case 'thinking':
        this.blocks.set(index, {
          type: 'thinking',
          thinking: block.thinking,
          signature: block.signature,
        });
        break;
      case 'redacted_thinking':
        // A redacted block arrives complete; no deltas follow it.
        this.blocks.set(index, {type: 'redacted_thinking', data: block.data});
        break;
      case 'text':
        this.blocks.set(index, {type: 'text', text: block.text});
        break;
      case 'tool_use':
        this.blocks.set(index, {
          type: 'tool_use',
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
    this.thinkingAt(index).thinking += thinking;
  }

  appendSignature(index: number, signature: string): void {
    this.thinkingAt(index).signature += signature;
  }

  appendText(index: number, text: string): void {
    const block = this.blocks.get(index);
    if (block?.type === 'text') {
      block.text += text;
      return;
    }
    this.blocks.set(index, {type: 'text', text});
  }

  appendToolArgs(index: number, partialJson: string): void {
    const block = this.blocks.get(index);
    if (block?.type === 'tool_use') {
      block.argsJson += partialJson;
    }
  }

  /** Returns the accumulated parts in ascending block index. */
  toParts(): Part[] {
    return [...this.blocks]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => streamedBlockToPart(block));
  }

  /** Returns the thinking block at `index`, starting one if a delta leads. */
  private thinkingAt(index: number): StreamedBlock & {type: 'thinking'} {
    const block = this.blocks.get(index);
    if (block?.type === 'thinking') {
      return block;
    }
    const started = {type: 'thinking', thinking: '', signature: ''} as const;
    this.blocks.set(index, started);
    return started;
  }
}

/** Wraps one streamed chunk as a partial response. */
function partialResponse(part: Part): LlmResponse {
  return {content: {role: 'model', parts: [part]}, partial: true};
}

/**
 * Records one content-block delta and returns the part the caller should emit.
 *
 * A signature delta returns nothing: the signature is opaque rather than
 * user-visible text. It still has to be accumulated, because a thinking block
 * that reaches the next turn unsigned makes Claude reject the request.
 */
function contentBlockDeltaPart(
  blocks: StreamedContentBlocks,
  event: Anthropic.RawContentBlockDeltaEvent,
): Part | undefined {
  const {delta, index} = event;
  switch (delta.type) {
    case 'thinking_delta':
      blocks.appendThinking(index, delta.thinking);
      return {text: delta.thinking, thought: true};
    case 'signature_delta':
      blocks.appendSignature(index, delta.signature);
      return undefined;
    case 'text_delta':
      blocks.appendText(index, delta.text);
      return {text: delta.text};
    case 'input_json_delta':
      blocks.appendToolArgs(index, delta.partial_json);
      return undefined;
    default:
      return undefined;
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
      case 'content_block_delta': {
        const part = contentBlockDeltaPart(blocks, event);
        if (part) {
          yield partialResponse(part);
        }
        break;
      }
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
      if (isMissingCredentialError(err)) {
        throw new AnthropicCredentialError(err);
      }
      throw err;
    }
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
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
   * The SDK resolves the credential itself, from `ANTHROPIC_API_KEY`,
   * `ANTHROPIC_AUTH_TOKEN`, or the on-disk Anthropic configuration.
   */
  protected async createClient(): Promise<AnthropicClient> {
    if (this.injectedClient) {
      return this.injectedClient;
    }
    const {Anthropic: AnthropicApiClient} = await loadOptionalPeer(
      ANTHROPIC_SDK,
      () => import('@anthropic-ai/sdk'),
    );
    return new AnthropicApiClient();
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

    const messages = llmRequest.contents.map((content) =>
      contentToMessageParam(content, sanitizer),
    );
    const tools = declarations.map(functionDeclarationToToolParam);
    const systemInstruction = extractSystemInstruction(config ?? {});
    const cacheConfig = resolveCacheConfig(llmRequest);
    const system = cacheConfig
      ? applyCacheBreakpoints({
          cacheConfig,
          system: systemInstruction,
          messages,
          tools,
        })
      : systemInstruction;

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.resolveModelName(llmRequest.model),
      messages,
      max_tokens: config?.maxOutputTokens ?? this.maxTokens,
    };
    if (system) {
      params.system = system;
    }
    if (tools.length) {
      params.tools = tools;
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
