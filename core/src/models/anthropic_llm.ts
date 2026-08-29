/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParamsBase,
  MessageCreateParamsNonStreaming,
  RawContentBlockDelta,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  FunctionDeclaration,
  GenerateContentConfig,
  Part,
} from '@google/genai';

import {isBrowser} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {
  buildEffortParam,
  buildThinkingParam,
  contentToMessageParam,
  functionDeclarationToToolParam,
  messageToLlmResponse,
  systemInstructionToText,
  ToolUseIdSanitizer,
} from './anthropic_utils.js';
import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/** The Claude model used when none is given. */
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

/** The Vertex AI Claude model used when none is given. */
const DEFAULT_CLAUDE_VERTEX_MODEL = 'claude-3-5-sonnet-v2@20241022';

/** The default output token budget, matching adk-python. */
const DEFAULT_MAX_TOKENS = 8192;

/** Extracts the model id from a Vertex AI model resource name. */
const VERTEX_MODEL_RESOURCE_NAME =
  /^projects\/[^/]+\/locations\/[^/]+\/(?:publishers\/anthropic\/models|endpoints)\/([^/:]+)/;

/** Extracts the project and the location from a Vertex AI resource name. */
const VERTEX_PROJECT_AND_LOCATION = /^projects\/([^/]+)\/locations\/([^/]+)\//;

const PROJECT_ENV_VARIABLE_NAME = 'GOOGLE_CLOUD_PROJECT';
const LOCATION_ENV_VARIABLE_NAME = 'GOOGLE_CLOUD_LOCATION';

const MISSING_ANTHROPIC_CREDENTIAL_MESSAGE =
  'No Anthropic credential was found for calling Claude through the ' +
  'Anthropic API. Set ANTHROPIC_API_KEY to a key from the Anthropic Console, ' +
  'e.g. `export ANTHROPIC_API_KEY=<your-key>`, or configure any other ' +
  'credential the Anthropic SDK can discover.';

const RATE_LIMIT_POSSIBLE_FIX_MESSAGE =
  'On how to mitigate this issue, please refer to:\n\n' +
  'https://docs.anthropic.com/en/api/errors#http-errors';

/** The HTTP status Anthropic returns when the caller exceeds a rate limit. */
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * The part of the Anthropic client this provider drives.
 *
 * Both `Anthropic` and `AnthropicVertex` satisfy it, so one implementation
 * serves the direct API and Vertex AI.
 */
export interface AnthropicMessagesClient {
  messages: Pick<Anthropic['messages'], 'create'> & {
    stream(
      params: MessageCreateParamsBase,
      options?: {signal?: AbortSignal},
    ): AnthropicMessageStream;
  };
}

/**
 * The part of the SDK's `MessageStream` this provider consumes.
 *
 * `MessageStream` declares a private field, so it is nominally typed and no
 * test double can stand in for it. Naming the two members used here keeps an
 * injected client testable, and a real `MessageStream` still satisfies it.
 */
export interface AnthropicMessageStream extends AsyncIterable<RawMessageStreamEvent> {
  finalMessage(): Promise<Message>;
}

/** Parameters for creating an {@link AnthropicLlm}. */
export interface AnthropicLlmParams {
  /** The Claude model name. Defaults to `claude-sonnet-4-20250514`. */
  model?: string;
  /** The maximum number of tokens to generate. Defaults to 8192. */
  maxTokens?: number;
  /**
   * A ready client, for a custom base URL, a proxy, or a test double.
   *
   * Supplying one skips loading the SDK and resolving a credential.
   */
  client?: AnthropicMessagesClient;
}

/** Parameters for creating a {@link Claude}. */
export interface ClaudeParams extends AnthropicLlmParams {
  /** Vertex AI project. Falls back to `GOOGLE_CLOUD_PROJECT`. */
  project?: string;
  /** Vertex AI location. Falls back to `GOOGLE_CLOUD_LOCATION`. */
  location?: string;
}

/** Collects the function declarations of every tool on the request. */
function collectFunctionDeclarations(
  config?: GenerateContentConfig,
): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];
  for (const tool of config?.tools ?? []) {
    if ('functionDeclarations' in tool && tool.functionDeclarations) {
      declarations.push(...tool.functionDeclarations);
    }
  }
  return declarations;
}

/**
 * Copies the sampling parameters onto the request.
 *
 * Claude rejects `temperature`, `top_p` and `top_k` alongside extended
 * thinking or a reasoning effort, so they are dropped with a warning whenever
 * either is in force.
 *
 * @param excluded Whether thinking or a reasoning effort is in force.
 */
function applySamplingParams(
  params: MessageCreateParamsNonStreaming,
  config: GenerateContentConfig | undefined,
  excluded: boolean,
): void {
  const {temperature, topP, topK} = config ?? {};
  if (temperature === undefined && topP === undefined && topK === undefined) {
    return;
  }
  if (excluded) {
    logger.warn(
      'Sampling parameters (temperature, top_p, top_k) are ignored because ' +
        'thinking or a reasoning effort is enabled.',
    );
    return;
  }
  if (temperature !== undefined) {
    params.temperature = temperature;
  }
  if (topP !== undefined) {
    params.top_p = topP;
  }
  if (topK !== undefined) {
    params.top_k = Math.trunc(topK);
  }
}

/**
 * Builds the Anthropic request body for one ADK request.
 *
 * One {@link ToolUseIdSanitizer} covers the whole request, so a `tool_use`
 * block and the `tool_result` block answering it keep matching ids.
 */
function buildMessageCreateParams(
  llmRequest: LlmRequest,
  model: string,
  maxTokens: number,
): MessageCreateParamsNonStreaming {
  const config = llmRequest.config;
  const sanitizer = new ToolUseIdSanitizer();
  const params: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: config?.maxOutputTokens ?? maxTokens,
    messages: llmRequest.contents.map((content) =>
      contentToMessageParam(content, sanitizer),
    ),
  };

  const system = systemInstructionToText(config?.systemInstruction);
  if (system) {
    params.system = system;
  }

  // Gated on the declarations, not on `toolsDict`: a plugin can register a
  // tool there without declaring it, and Anthropic rejects a `tool_choice`
  // sent without `tools`.
  const declarations = collectFunctionDeclarations(config);
  if (declarations.length > 0) {
    params.tools = declarations.map(functionDeclarationToToolParam);
    params.tool_choice = {type: 'auto'};
  }

  if (config?.stopSequences && config.stopSequences.length > 0) {
    params.stop_sequences = [...config.stopSequences];
  }

  const thinking = buildThinkingParam(config);
  if (thinking) {
    params.thinking = thinking;
  }

  const effort = buildEffortParam(config);
  if (effort !== undefined) {
    params.output_config = {effort};
  }

  const thinkingEnabled =
    thinking?.type === 'enabled' || thinking?.type === 'adaptive';
  applySamplingParams(params, config, thinkingEnabled || effort !== undefined);

  return params;
}

/** The shape of the rate-limit error this provider annotates. */
interface RateLimitedError {
  status: number;
  message: string;
}

/**
 * Reports whether an error is an Anthropic rate-limit error.
 *
 * The status is read structurally rather than with `instanceof
 * RateLimitError`, which would need a value import of the optional SDK.
 */
function isRateLimited(error: unknown): error is RateLimitedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === HTTP_TOO_MANY_REQUESTS &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

/**
 * Adds the documented mitigation to an Anthropic rate-limit error.
 *
 * The message is rewritten in place so the SDK's own error reaches the caller
 * with `status`, `headers` and the `retry-after` value a backoff reads.
 *
 * @return The error to throw, unchanged unless it reports HTTP 429.
 */
function withRateLimitHelp(error: unknown): unknown {
  if (isRateLimited(error)) {
    error.message = `${RATE_LIMIT_POSSIBLE_FIX_MESSAGE}\n\n${error.message}`;
  }
  return error;
}

/**
 * The text one streamed delta adds.
 *
 * @return The part to emit, or `undefined` for a delta that carries no text a
 *   reader can show, such as a thinking signature or a tool argument fragment.
 */
function deltaToPart(delta: RawContentBlockDelta): Part | undefined {
  switch (delta.type) {
    case 'text_delta':
      return {text: delta.text};
    case 'thinking_delta':
      return {text: delta.thinking, thought: true};
    default:
      return undefined;
  }
}

/** Yields one partial response per streamed delta that carries text. */
async function* streamPartials(
  events: AsyncIterable<RawMessageStreamEvent>,
): AsyncGenerator<LlmResponse, void> {
  for await (const event of events) {
    const part =
      event.type === 'content_block_delta'
        ? deltaToPart(event.delta)
        : undefined;
    if (part) {
      yield {content: {role: 'model', parts: [part]}, partial: true};
    }
  }
}

/**
 * Claude models served by the Anthropic API.
 *
 * The Anthropic SDK is an optional peer dependency, loaded the first time a
 * request is sent, so importing `@google/adk` never pulls it in.
 */
export class AnthropicLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    /claude-.*/,
  ];

  protected readonly maxTokens: number;

  private clientPromise?: Promise<AnthropicMessagesClient>;

  constructor({model, maxTokens, client}: AnthropicLlmParams = {}) {
    super({model: model ?? DEFAULT_ANTHROPIC_MODEL});
    this.maxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
    if (client) {
      this.clientPromise = Promise.resolve(client);
    }
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const params = buildMessageCreateParams(
      llmRequest,
      this.resolveModelName(llmRequest.model),
      this.maxTokens,
    );
    try {
      const client = await this.getClient();
      if (!stream) {
        const message = await client.messages.create(params, {
          signal: abortSignal,
        });
        yield messageToLlmResponse(message);
        return;
      }

      // `stream()` returns the SDK's own accumulator, so the aggregated
      // message it reports is assembled by the same code the non-streaming
      // path relies on.
      const events = client.messages.stream(params, {signal: abortSignal});
      yield* streamPartials(events);
      yield {
        ...messageToLlmResponse(await events.finalMessage()),
        partial: false,
      };
    } catch (error: unknown) {
      throw withRateLimitHelp(error);
    }
  }

  override async connect(): Promise<BaseLlmConnection> {
    throw new Error(
      'Live connections are not supported for Anthropic Claude models.',
    );
  }

  /** Resolves the Anthropic client, loading its package on first use. */
  protected getClient(): Promise<AnthropicMessagesClient> {
    this.clientPromise ??= this.createClient();
    return this.clientPromise;
  }

  /**
   * Builds the client, letting the SDK resolve its own credential.
   *
   * The SDK reads more credential sources than the environment variable, so
   * the constructed client is asked what it found rather than the sources
   * being enumerated here. Only the presence of a credential is read, never
   * its value.
   */
  protected createClient(): Promise<AnthropicMessagesClient> {
    return loadOptionalPeer(
      {packageName: '@anthropic-ai/sdk', feature: 'AnthropicLlm'},
      () => import('@anthropic-ai/sdk'),
    ).then(({Anthropic}) => {
      const client = new Anthropic();
      if (!client.apiKey && !client.authToken && !client.credentials) {
        throw new Error(MISSING_ANTHROPIC_CREDENTIAL_MESSAGE);
      }
      return client;
    });
  }

  /**
   * Reduces a Vertex AI model resource name to the bare model id the
   * Anthropic API expects, and leaves any other name unchanged.
   */
  private resolveModelName(model?: string): string {
    if (!model) {
      return this.model;
    }
    const match = VERTEX_MODEL_RESOURCE_NAME.exec(model);
    return match ? match[1] : model;
  }
}

/**
 * Claude models served by Vertex AI.
 *
 * `model` defaults to `claude-3-5-sonnet-v2@20241022`.
 *
 * The project and the location come from the `project` and `location`
 * parameters, then from `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`. A
 * full `projects/.../locations/...` model resource name names both inline and
 * takes precedence over either. They are read on first use, so constructing
 * the model in an unconfigured environment does not throw.
 */
export class Claude extends AnthropicLlm {
  private readonly project?: string;
  private readonly location?: string;

  constructor({
    model,
    maxTokens,
    client,
    project,
    location,
  }: ClaudeParams = {}) {
    super({model: model ?? DEFAULT_CLAUDE_VERTEX_MODEL, maxTokens, client});
    this.project = project;
    this.location = location;
  }

  protected override createClient(): Promise<AnthropicMessagesClient> {
    const {projectId, region} = this.resolveVertexTarget();
    return loadOptionalPeer(
      {packageName: '@anthropic-ai/vertex-sdk', feature: 'Claude'},
      () => import('@anthropic-ai/vertex-sdk'),
    ).then(
      ({AnthropicVertex}) =>
        new AnthropicVertex({
          projectId,
          region,
          defaultHeaders: this.trackingHeaders,
        }),
    );
  }

  private resolveVertexTarget(): {projectId: string; region: string} {
    const env: Record<string, string | undefined> = isBrowser()
      ? {}
      : process.env;
    let projectId = this.project ?? env[PROJECT_ENV_VARIABLE_NAME];
    let region = this.location ?? env[LOCATION_ENV_VARIABLE_NAME];

    const match = VERTEX_PROJECT_AND_LOCATION.exec(this.model);
    if (match) {
      projectId = match[1];
      region = match[2];
    }

    if (!projectId || !region) {
      throw new Error(
        `The model "${this.model}" resolves to Claude served from Vertex AI, ` +
          `which needs ${PROJECT_ENV_VARIABLE_NAME} and ` +
          `${LOCATION_ENV_VARIABLE_NAME} to be set, or the "project" and ` +
          `"location" parameters to be passed. To call the Anthropic API ` +
          `directly instead, set ANTHROPIC_API_KEY and give the agent an ` +
          `AnthropicLlm instance as its model.`,
      );
    }
    return {projectId, region};
  }
}
