/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import type {
  MessageCreateParamsNonStreaming,
  RawContentBlockDeltaEvent,
  RawContentBlockStartEvent,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
import type {Part} from '@google/genai';

import {isBrowser} from '../utils/env_aware_utils.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';

import {
  buildThinkingParam,
  contentToMessageParam,
  functionDeclarationToToolParam,
  messageToLlmResponse,
  parseToolUseArgs,
  systemInstructionToText,
  ToolUseIdSanitizer,
} from './anthropic_utils.js';
import {BaseLlm} from './base_llm.js';
import type {BaseLlmConnection} from './base_llm_connection.js';
import type {LlmRequest} from './llm_request.js';
import type {LlmResponse} from './llm_response.js';

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

/**
 * The part of the Anthropic client this provider drives.
 *
 * Both `Anthropic` and `AnthropicVertex` satisfy it, so one implementation
 * serves the direct API and Vertex AI.
 */
export interface AnthropicMessagesClient {
  messages: Pick<Anthropic['messages'], 'create'>;
}

/** Parameters for creating an {@link AnthropicLlm}. */
export interface AnthropicLlmParams {
  /** The Claude model name. Defaults to `claude-sonnet-4-20250514`. */
  model?: string;
  /** The maximum number of tokens to generate. Defaults to 8192. */
  maxTokens?: number;
}

/** Parameters for creating a {@link Claude}. */
export interface ClaudeParams extends AnthropicLlmParams {
  /** The Claude model name. Defaults to `claude-3-5-sonnet-v2@20241022`. */
  model?: string;
}

interface ToolUseAccumulator {
  id: string;
  name: string;
  argsJson: string;
}

interface ThinkingAccumulator {
  thinking: string;
  signature: string;
}

/**
 * Collects the content blocks of one streamed Claude message.
 *
 * Claude streams a message as indexed blocks, each arriving as a start event
 * followed by deltas. The accumulator keeps one entry per index so the final
 * aggregated response carries the same parts, in the same order, that the
 * equivalent non-streaming response would.
 */
class StreamedMessage {
  private readonly textBlocks = new Map<number, string>();
  private readonly toolUseBlocks = new Map<number, ToolUseAccumulator>();
  private readonly thinkingBlocks = new Map<number, ThinkingAccumulator>();
  private readonly redactedThinkingBlocks = new Map<number, string>();
  private inputTokens = 0;
  private outputTokens = 0;

  setPromptTokens(count: number): void {
    this.inputTokens = count;
  }

  setOutputTokens(count: number): void {
    this.outputTokens = count;
  }

  startBlock(event: RawContentBlockStartEvent): void {
    const block = event.content_block;
    switch (block.type) {
      case 'thinking':
        this.thinkingBlocks.set(event.index, {
          thinking: block.thinking,
          signature: block.signature,
        });
        break;
      case 'redacted_thinking':
        // A redacted block arrives complete; no deltas follow it.
        this.redactedThinkingBlocks.set(event.index, block.data);
        break;
      case 'text':
        this.textBlocks.set(event.index, block.text);
        break;
      case 'tool_use':
        this.toolUseBlocks.set(event.index, {
          id: block.id,
          name: block.name,
          argsJson: '',
        });
        break;
      default:
        break;
    }
  }

  /**
   * Applies one delta event.
   *
   * @return The partial response to emit, or `undefined` when the delta only
   *   accumulates state.
   */
  applyDelta(event: RawContentBlockDeltaEvent): LlmResponse | undefined {
    const delta = event.delta;
    switch (delta.type) {
      case 'thinking_delta': {
        const acc = this.thinkingBlocks.get(event.index) ?? {
          thinking: '',
          signature: '',
        };
        acc.thinking += delta.thinking;
        this.thinkingBlocks.set(event.index, acc);
        return {
          content: {
            role: 'model',
            parts: [{text: delta.thinking, thought: true}],
          },
          partial: true,
        };
      }
      case 'text_delta': {
        const text = (this.textBlocks.get(event.index) ?? '') + delta.text;
        this.textBlocks.set(event.index, text);
        return {
          content: {role: 'model', parts: [{text: delta.text}]},
          partial: true,
        };
      }
      case 'input_json_delta': {
        const acc = this.toolUseBlocks.get(event.index);
        if (acc) {
          acc.argsJson += delta.partial_json;
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }

  /** Builds the single aggregated response that closes the stream. */
  finalResponse(): LlmResponse {
    const indices = new Set<number>([
      ...this.thinkingBlocks.keys(),
      ...this.redactedThinkingBlocks.keys(),
      ...this.textBlocks.keys(),
      ...this.toolUseBlocks.keys(),
    ]);
    const parts: Part[] = [];
    for (const index of [...indices].sort((a, b) => a - b)) {
      const thinking = this.thinkingBlocks.get(index);
      if (thinking) {
        const part: Part = {text: thinking.thinking, thought: true};
        if (thinking.signature) {
          part.thoughtSignature = thinking.signature;
        }
        parts.push(part);
      }
      const redacted = this.redactedThinkingBlocks.get(index);
      if (redacted !== undefined) {
        parts.push({thought: true, thoughtSignature: redacted});
      }
      const text = this.textBlocks.get(index);
      if (text !== undefined) {
        parts.push({text});
      }
      const toolUse = this.toolUseBlocks.get(index);
      if (toolUse) {
        parts.push({
          functionCall: {
            id: toolUse.id,
            name: toolUse.name,
            args: parseToolUseArgs(toolUse.argsJson),
          },
        });
      }
    }
    return {
      content: {role: 'model', parts},
      usageMetadata: {
        promptTokenCount: this.inputTokens,
        candidatesTokenCount: this.outputTokens,
        totalTokenCount: this.inputTokens + this.outputTokens,
      },
      partial: false,
    };
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
  const sanitizer = new ToolUseIdSanitizer();
  const params: MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    messages: llmRequest.contents.map((content) =>
      contentToMessageParam(content, sanitizer),
    ),
  };

  const system = systemInstructionToText(llmRequest.config?.systemInstruction);
  if (system !== undefined) {
    params.system = system;
  }

  const firstTool = llmRequest.config?.tools?.[0];
  const declarations =
    firstTool && 'functionDeclarations' in firstTool
      ? firstTool.functionDeclarations
      : undefined;
  if (declarations && declarations.length > 0) {
    params.tools = declarations.map(functionDeclarationToToolParam);
  }

  if (Object.keys(llmRequest.toolsDict).length > 0) {
    params.tool_choice = {type: 'auto'};
  }

  const thinking = buildThinkingParam(llmRequest.config);
  if (thinking) {
    params.thinking = thinking;
  }

  return params;
}

async function* streamResponses(
  events: AsyncIterable<RawMessageStreamEvent>,
): AsyncGenerator<LlmResponse, void> {
  const message = new StreamedMessage();
  for await (const event of events) {
    switch (event.type) {
      case 'message_start':
        message.setPromptTokens(event.message.usage.input_tokens);
        message.setOutputTokens(event.message.usage.output_tokens);
        break;
      case 'content_block_start':
        message.startBlock(event);
        break;
      case 'content_block_delta': {
        const partial = message.applyDelta(event);
        if (partial) {
          yield partial;
        }
        break;
      }
      case 'message_delta':
        message.setOutputTokens(event.usage.output_tokens);
        break;
      default:
        break;
    }
  }
  yield message.finalResponse();
}

/**
 * Claude models served by the Anthropic API.
 *
 * The Anthropic SDK is an optional peer dependency, loaded the first time a
 * request is sent, so importing `@google/adk` never pulls it in.
 */
export class AnthropicLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    /claude-3-.*/,
    /claude-.*-4.*/,
  ];

  protected readonly maxTokens: number;

  private clientPromise?: Promise<AnthropicMessagesClient>;

  constructor({model, maxTokens}: AnthropicLlmParams = {}) {
    super({model: model ?? DEFAULT_ANTHROPIC_MODEL});
    this.maxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
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
    const client = await this.getClient();

    if (!stream) {
      const message = await client.messages.create(params, {
        signal: abortSignal,
      });
      yield messageToLlmResponse(message);
      return;
    }

    const events = await client.messages.create(
      {...params, stream: true},
      {signal: abortSignal},
    );
    yield* streamResponses(events);
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

  protected createClient(): Promise<AnthropicMessagesClient> {
    return loadOptionalPeer(
      {packageName: '@anthropic-ai/sdk', feature: 'AnthropicLlm'},
      () => import('@anthropic-ai/sdk'),
    ).then(({Anthropic}) => new Anthropic());
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
 * The project and the location come from `GOOGLE_CLOUD_PROJECT` and
 * `GOOGLE_CLOUD_LOCATION`, or from a full `projects/.../locations/...` model
 * resource name, which takes precedence. They are read on first use, so
 * constructing the model in an unconfigured environment does not throw.
 */
export class Claude extends AnthropicLlm {
  constructor({model, maxTokens}: ClaudeParams = {}) {
    super({model: model ?? DEFAULT_CLAUDE_VERTEX_MODEL, maxTokens});
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
    let projectId = env[PROJECT_ENV_VARIABLE_NAME];
    let region = env[LOCATION_ENV_VARIABLE_NAME];

    const match = VERTEX_PROJECT_AND_LOCATION.exec(this.model);
    if (match) {
      projectId = match[1];
      region = match[2];
    }

    if (!projectId || !region) {
      throw new Error(
        `${PROJECT_ENV_VARIABLE_NAME} and ${LOCATION_ENV_VARIABLE_NAME} must ` +
          `be set for using Anthropic on Vertex.`,
      );
    }
    return {projectId, region};
  }
}
