/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import Anthropic from '@anthropic-ai/sdk';
import {AnthropicVertex} from '@anthropic-ai/vertex-sdk';
import {
  Content,
  FinishReason,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  Part,
  Tool,
} from '@google/genai';

import {logger} from '../utils/logger.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {extractSystemInstruction} from './interactions_utils.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/** Default number of output tokens when the request does not specify one. */
const DEFAULT_MAX_TOKENS = 8192;

/** Default model for the direct Anthropic API backend. */
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

/** Default model for the Vertex AI Claude backend. */
const DEFAULT_CLAUDE_VERTEX_MODEL = 'claude-3-5-sonnet-v2@20241022';

/** Anthropic tool ids must match this pattern; others are remapped. */
const VALID_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Maps Anthropic stop reasons to genai finish reasons. Unknown non-empty stop
 * reasons fall back to `FINISH_REASON_UNSPECIFIED`.
 */
const STOP_REASON_MAPPING: Readonly<Record<string, FinishReason>> = {
  end_turn: FinishReason.STOP,
  stop_sequence: FinishReason.STOP,
  tool_use: FinishReason.STOP,
  pause_turn: FinishReason.STOP,
  max_tokens: FinishReason.MAX_TOKENS,
  refusal: FinishReason.SAFETY,
};

/** Reasoning effort levels supported by newer Claude models. */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * The minimal Anthropic client surface used by this provider. Both the direct
 * `Anthropic` client and the `AnthropicVertex` client satisfy this contract.
 */
export interface AnthropicMessagesClient {
  messages: {create: Anthropic.Messages['create']};
}

/**
 * The parameters for creating an {@link AnthropicLlm} or {@link Claude}
 * instance.
 */
export interface AnthropicLlmParams {
  /** The name of the Claude model to use. */
  model?: string;
  /** The maximum number of tokens to generate. Defaults to 8192. */
  maxTokens?: number;
  /**
   * API key for the direct Anthropic API. If omitted, the SDK falls back to the
   * `ANTHROPIC_API_KEY` environment variable.
   */
  apiKey?: string;
  /** The Google Cloud project ID (Vertex AI backend). */
  project?: string;
  /** The Google Cloud location (Vertex AI backend). */
  location?: string;
  /** Additional headers merged with the internally crafted tracking headers. */
  headers?: Record<string, string>;
}

/**
 * Configuration options for Anthropic Claude content generation.
 *
 * This specialized configuration is the recommended way to configure reasoning
 * and extended thinking for newer Claude models. Set {@link effort} directly
 * instead of the standard `thinkingConfig.thinkingLevel`, which cannot map
 * consistently onto Anthropic's five effort levels.
 */
export interface AnthropicGenerateContentConfig extends GenerateContentConfig {
  /**
   * The reasoning effort level for adaptive extended thinking. This is the
   * preferred alternative to the deprecated manual `thinkingBudget` on newer
   * Claude models.
   */
  effort?: AnthropicEffort;
}

/**
 * Validates and returns an {@link AnthropicGenerateContentConfig}.
 *
 * TypeScript interfaces have no construction hook (unlike the pydantic model in
 * adk-python), so use this factory when you want the same eager validation:
 * it throws if `thinkingConfig.thinkingLevel` is set, which is unsupported for
 * Anthropic models.
 *
 * @param config The configuration to validate.
 * @returns The same configuration object.
 */
export function createAnthropicGenerateContentConfig(
  config: AnthropicGenerateContentConfig,
): AnthropicGenerateContentConfig {
  if (config.thinkingConfig?.thinkingLevel !== undefined) {
    throw new Error(
      'thinkingLevel is not supported in AnthropicGenerateContentConfig. Use ' +
        'the `effort` field directly to configure reasoning effort.',
    );
  }
  return config;
}

/**
 * Maps a genai content role to an Anthropic message role.
 *
 * @param role The genai role (`user`, `model`, or `assistant`).
 * @returns The Anthropic role.
 */
export function toClaudeRole(role?: string): 'user' | 'assistant' {
  if (role === 'model' || role === 'assistant') {
    return 'assistant';
  }
  return 'user';
}

/**
 * Maps an Anthropic stop reason to a genai finish reason.
 *
 * @param stopReason The Anthropic stop reason.
 * @returns The genai finish reason, or `undefined` when no stop reason is set.
 */
export function toGoogleGenaiFinishReason(
  stopReason?: string | null,
): FinishReason | undefined {
  if (stopReason === undefined || stopReason === null) {
    return undefined;
  }
  return (
    STOP_REASON_MAPPING[stopReason] ?? FinishReason.FINISH_REASON_UNSPECIFIED
  );
}

/**
 * Recursively lowercases nested JSON-schema `type` strings for Anthropic
 * compatibility (genai emits enum types such as `"OBJECT"`/`"STRING"`).
 *
 * @param value The JSON-schema value to normalize in place.
 */
export function updateTypeString(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      updateTypeString(item);
    }
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }

  const schema = value as Record<string, unknown>;
  if (typeof schema['type'] === 'string') {
    schema['type'] = schema['type'].toLowerCase();
  }

  for (const dictKey of [
    '$defs',
    'dependentSchemas',
    'patternProperties',
    'properties',
  ]) {
    const child = schema[dictKey];
    if (isPlainObject(child)) {
      for (const childValue of Object.values(child)) {
        updateTypeString(childValue);
      }
    }
  }

  for (const singleKey of [
    'additionalProperties',
    'contains',
    'else',
    'if',
    'items',
    'not',
    'propertyNames',
    'then',
    'unevaluatedProperties',
  ]) {
    const child = schema[singleKey];
    if (child !== null && typeof child === 'object') {
      updateTypeString(child);
    }
  }

  for (const listKey of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const child = schema[listKey];
    if (Array.isArray(child)) {
      updateTypeString(child);
    }
  }
}

/**
 * Converts a genai function declaration to an Anthropic tool param, lowercasing
 * schema type strings. Supports both `parametersJsonSchema` and `parameters`.
 *
 * @param functionDeclaration The genai function declaration.
 * @returns The Anthropic tool definition.
 */
export function functionDeclarationToToolParam(
  functionDeclaration: FunctionDeclaration,
): Anthropic.Tool {
  if (!functionDeclaration.name) {
    throw new Error('Function declaration must have a name.');
  }

  let inputSchema: Record<string, unknown>;
  if (functionDeclaration.parametersJsonSchema) {
    inputSchema = deepCopyToPlainObject(
      functionDeclaration.parametersJsonSchema,
    );
    updateTypeString(inputSchema);
  } else {
    const properties: Record<string, unknown> = {};
    let requiredParams: string[] = [];
    const parameters = functionDeclaration.parameters;
    if (parameters) {
      if (parameters.properties) {
        for (const [key, value] of Object.entries(parameters.properties)) {
          properties[key] = deepCopyToPlainObject(value);
        }
      }
      if (parameters.required) {
        requiredParams = parameters.required;
      }
    }
    inputSchema = {type: 'object', properties};
    if (requiredParams.length) {
      inputSchema['required'] = requiredParams;
    }
    updateTypeString(inputSchema);
  }

  return {
    name: functionDeclaration.name,
    description: functionDeclaration.description ?? '',
    input_schema: inputSchema as Anthropic.Tool.InputSchema,
  };
}

/**
 * Maps invalid tool_use ids to deterministic fallbacks. Reuse one instance per
 * conversation so a `tool_use` and its paired `tool_result` with the same
 * invalid source id receive matching outputs.
 */
export class ToolUseIdSanitizer {
  private readonly mapping = new Map<string, string>();
  private nextFallback = 0;

  /**
   * Returns a valid Anthropic tool id, remapping invalid ones deterministically.
   *
   * @param toolId The source tool id, which may be missing or invalid.
   * @returns A tool id matching `[a-zA-Z0-9_-]+`.
   */
  sanitize(toolId?: string | null): string {
    if (toolId && VALID_TOOL_ID_PATTERN.test(toolId)) {
      return toolId;
    }
    const key = toolId ?? '';
    let mapped = this.mapping.get(key);
    if (mapped === undefined) {
      mapped = `toolu_fallback_${this.nextFallback}`;
      this.nextFallback += 1;
      this.mapping.set(key, mapped);
    }
    return mapped;
  }
}

/**
 * Converts an Anthropic content block to a genai part.
 *
 * @param contentBlock The Anthropic content block.
 * @returns The genai part.
 */
export function contentBlockToPart(contentBlock: Anthropic.ContentBlock): Part {
  if (contentBlock.type === 'thinking') {
    const part: Part = {text: contentBlock.thinking, thought: true};
    if (contentBlock.signature) {
      part.thoughtSignature = contentBlock.signature;
    }
    return part;
  }
  if (contentBlock.type === 'redacted_thinking') {
    // Preserve the encrypted blob so it can round-trip back to Claude in the
    // next turn; required to keep the model's reasoning chain intact.
    return {thought: true, thoughtSignature: contentBlock.data};
  }
  if (contentBlock.type === 'text') {
    return {text: contentBlock.text};
  }
  if (contentBlock.type === 'tool_use') {
    return {
      functionCall: {
        id: contentBlock.id,
        name: contentBlock.name,
        args: contentBlock.input as Record<string, unknown>,
      },
    };
  }
  throw new Error(`Unsupported content block type: ${contentBlock.type}`);
}

/**
 * Converts a full Anthropic message to a genai {@link LlmResponse}.
 *
 * @param message The Anthropic message.
 * @returns The genai LlmResponse.
 */
export function messageToGenerateContentResponse(
  message: Anthropic.Message,
): LlmResponse {
  logger.info('Received response from Claude.');

  const parts = message.content.map((block) => contentBlockToPart(block));

  return {
    content: {role: 'model', parts},
    usageMetadata: buildUsageMetadata(
      message.usage.input_tokens,
      message.usage.output_tokens,
      extractCachedTokenCount(message.usage),
    ),
    finishReason: toGoogleGenaiFinishReason(message.stop_reason),
  };
}

/**
 * Maps a genai `ThinkingConfig` to an Anthropic thinking parameter.
 *
 * `thinkingBudget` semantics: `undefined` throws (an explicit choice is
 * required); `0` disables thinking; a negative value maps to adaptive thinking;
 * a positive value is a manual token budget (validated by the Anthropic API).
 *
 * @param config The genai generate-content config.
 * @returns The Anthropic thinking param, or `undefined` when not configured.
 */
export function buildAnthropicThinkingParam(
  config?: GenerateContentConfig,
): Anthropic.ThinkingConfigParam | undefined {
  if (!config || !config.thinkingConfig) {
    return undefined;
  }

  const thinkingBudget = config.thinkingConfig.thinkingBudget;
  if (thinkingBudget === undefined) {
    throw new Error(
      'thinkingBudget must be set explicitly when ThinkingConfig is provided ' +
        'for Anthropic models. Use 0 to disable thinking, -1 for adaptive ' +
        '(model-chosen depth), or a positive integer (>= 1024) for manual ' +
        'budgeting.',
    );
  }
  if (thinkingBudget === 0) {
    return {type: 'disabled'};
  }
  if (thinkingBudget < 0) {
    return {type: 'adaptive'};
  }
  return {type: 'enabled', budget_tokens: thinkingBudget};
}

/**
 * Extracts the Anthropic effort parameter from the configuration.
 *
 * `effort` (via {@link AnthropicGenerateContentConfig}) takes precedence. The
 * standard `thinkingConfig.thinkingLevel` is unsupported and, if set without
 * `effort`, logs a warning and is ignored.
 *
 * @param config The genai generate-content config.
 * @returns The effort level, or `undefined` when not specified.
 */
export function buildEffortParam(
  config?: GenerateContentConfig,
): AnthropicEffort | undefined {
  if (!config) {
    return undefined;
  }

  if ('effort' in config) {
    const effort = (config as AnthropicGenerateContentConfig).effort;
    if (effort) {
      return effort;
    }
  }

  if (config.thinkingConfig?.thinkingLevel) {
    logger.warn(
      'Standard thinking_config.thinking_level is not supported for Anthropic ' +
        'models and will be ignored. Use AnthropicGenerateContentConfig and ' +
        'set the `effort` field directly to configure reasoning effort.',
    );
  }

  return undefined;
}

/**
 * Integration with Claude models via the direct Anthropic API.
 *
 * Anthropic Claude supports five effort levels (`low`, `medium`, `high`,
 * `xhigh`, `max`) while the standard `ThinkingLevel` enum defines four, so the
 * standard `thinkingConfig.thinkingLevel` is not supported. Use
 * {@link AnthropicGenerateContentConfig} and set its `effort` field instead.
 */
export class AnthropicLlm extends BaseLlm {
  protected readonly maxTokens: number;
  protected readonly apiKey?: string;
  protected readonly project?: string;
  protected readonly location?: string;
  protected readonly headers?: Record<string, string>;
  private cachedClient?: AnthropicMessagesClient;

  /**
   * @param params The parameters for creating an AnthropicLlm instance.
   */
  constructor(params: AnthropicLlmParams = {}) {
    super({model: params.model ?? DEFAULT_ANTHROPIC_MODEL});
    this.maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.apiKey = params.apiKey;
    this.project = params.project;
    this.location = params.location;
    this.headers = params.headers;
  }

  /**
   * A list of model name patterns supported by this provider.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /claude-3-.*/,
    /claude-.*-4.*/,
  ];

  /**
   * Sends a request to the Claude model.
   *
   * @param llmRequest The request to send to the model.
   * @param stream Whether to do a streaming call.
   * @param abortSignal Optional signal to abort the request.
   * @yields The model response(s).
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const sanitizer = new ToolUseIdSanitizer();
    const messages = (llmRequest.contents ?? []).map((content) =>
      contentToMessageParam(content, sanitizer),
    );

    const firstTool = llmRequest.config?.tools?.[0] as Tool | undefined;
    const functionDeclarations = firstTool?.functionDeclarations;
    const tools =
      functionDeclarations && functionDeclarations.length
        ? functionDeclarations.map((declaration) =>
            functionDeclarationToToolParam(declaration),
          )
        : undefined;

    const toolChoice: Anthropic.ToolChoiceAuto | undefined =
      Object.keys(llmRequest.toolsDict).length > 0 ? {type: 'auto'} : undefined;

    const thinking = buildAnthropicThinkingParam(llmRequest.config);

    const params = this.buildAnthropicParams(
      llmRequest,
      messages,
      tools,
      toolChoice,
      thinking,
    );

    logger.info(
      `Sending out request, model: ${params.model}, stream: ${stream}`,
    );

    if (!stream) {
      const message = (await this.anthropicClient.messages.create(params, {
        signal: abortSignal,
      })) as Anthropic.Message;
      yield messageToGenerateContentResponse(message);
    } else {
      yield* this.generateContentStreaming(params, abortSignal);
    }
  }

  /**
   * Live/bidi connections are not supported for Anthropic models.
   *
   * @param _llmRequest The request (unused).
   * @throws Always, because Anthropic has no live API here.
   */
  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connection is not supported for Anthropic models.');
  }

  /**
   * The lazily-created Anthropic client. Memoized after first access.
   */
  protected get anthropicClient(): AnthropicMessagesClient {
    if (!this.cachedClient) {
      this.cachedClient = this.createAnthropicClient();
    }
    return this.cachedClient;
  }

  /**
   * Creates the underlying Anthropic client. Overridden by {@link Claude} for
   * the Vertex AI backend.
   *
   * @returns The Anthropic client.
   */
  protected createAnthropicClient(): AnthropicMessagesClient {
    return new Anthropic({
      apiKey: this.apiKey,
      defaultHeaders: {...this.trackingHeaders, ...this.headers},
    });
  }

  private buildAnthropicParams(
    llmRequest: LlmRequest,
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[] | undefined,
    toolChoice: Anthropic.ToolChoiceAuto | undefined,
    thinking: Anthropic.ThinkingConfigParam | undefined,
  ): Anthropic.MessageCreateParamsNonStreaming {
    const config = llmRequest.config;

    let system: string | undefined;
    if (config) {
      const systemStr = extractSystemInstruction(config);
      if (systemStr) {
        system = systemStr;
      }
    }

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.resolveModelName(llmRequest.model),
      messages,
      max_tokens: this.maxTokens,
      system,
      tools,
      tool_choice: toolChoice,
      thinking,
    };

    const effort = buildEffortParam(config);
    if (effort) {
      params.output_config = {effort};
    }

    const thinkingEnabled =
      thinking?.type === 'enabled' || thinking?.type === 'adaptive';
    const excludeSampling = thinkingEnabled || effort !== undefined;

    if (config) {
      if (!excludeSampling) {
        if (config.temperature !== undefined) {
          params.temperature = config.temperature;
        }
        if (config.topP !== undefined) {
          params.top_p = config.topP;
        }
        if (config.topK !== undefined) {
          params.top_k = Math.trunc(config.topK);
        }
      } else if (
        config.temperature !== undefined ||
        config.topP !== undefined ||
        config.topK !== undefined
      ) {
        logger.warn(
          'Sampling parameters (temperature, top_p, top_k) are ignored ' +
            'because thinking/effort is enabled.',
        );
      }

      if (config.stopSequences) {
        params.stop_sequences = config.stopSequences;
      }

      if (config.maxOutputTokens !== undefined) {
        params.max_tokens = config.maxOutputTokens;
      }
    }

    return params;
  }

  private async *generateContentStreaming(
    params: Anthropic.MessageCreateParamsNonStreaming,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const streamingParams: Anthropic.MessageCreateParamsStreaming = {
      ...params,
      stream: true,
    };
    const rawStream = (await this.anthropicClient.messages.create(
      streamingParams,
      {signal: abortSignal},
    )) as AsyncIterable<Anthropic.RawMessageStreamEvent>;

    const textBlocks = new Map<number, string>();
    const toolUseBlocks = new Map<number, ToolUseAccumulator>();
    const thinkingBlocks = new Map<number, ThinkingAccumulator>();
    const redactedThinkingBlocks = new Map<number, string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens: number | undefined;
    let stopReason: string | null | undefined;

    for await (const event of rawStream) {
      if (event.type === 'message_start') {
        inputTokens = event.message.usage.input_tokens;
        outputTokens = event.message.usage.output_tokens;
        cachedInputTokens = extractCachedTokenCount(event.message.usage);
      } else if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'thinking') {
          thinkingBlocks.set(event.index, {
            thinking: block.thinking,
            signature: block.signature,
          });
        } else if (block.type === 'redacted_thinking') {
          // Redacted blocks arrive fully formed at start; no deltas follow.
          redactedThinkingBlocks.set(event.index, block.data);
        } else if (block.type === 'text') {
          textBlocks.set(event.index, block.text);
        } else if (block.type === 'tool_use') {
          toolUseBlocks.set(event.index, {
            id: block.id,
            name: block.name,
            argsJson: '',
          });
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'thinking_delta') {
          const acc = getOrCreateThinking(thinkingBlocks, event.index);
          acc.thinking += delta.thinking;
          yield {
            content: {
              role: 'model',
              parts: [{text: delta.thinking, thought: true}],
            },
            partial: true,
          };
        } else if (delta.type === 'signature_delta') {
          // Accumulate the block signature so the aggregated thinking Part
          // carries `thoughtSignature` and can round-trip back to Claude.
          const acc = getOrCreateThinking(thinkingBlocks, event.index);
          acc.signature += delta.signature;
        } else if (delta.type === 'text_delta') {
          textBlocks.set(
            event.index,
            (textBlocks.get(event.index) ?? '') + delta.text,
          );
          yield {
            content: {role: 'model', parts: [{text: delta.text}]},
            partial: true,
          };
        } else if (delta.type === 'input_json_delta') {
          const acc = toolUseBlocks.get(event.index);
          if (acc) {
            acc.argsJson += delta.partial_json;
          }
        }
      } else if (event.type === 'message_delta') {
        outputTokens = event.usage.output_tokens;
        stopReason = event.delta.stop_reason;
      }
    }

    const allParts: Part[] = [];
    const allIndices = [
      ...new Set([
        ...thinkingBlocks.keys(),
        ...redactedThinkingBlocks.keys(),
        ...textBlocks.keys(),
        ...toolUseBlocks.keys(),
      ]),
    ].sort((a, b) => a - b);

    for (const index of allIndices) {
      const thinkingAcc = thinkingBlocks.get(index);
      if (thinkingAcc) {
        const part: Part = {text: thinkingAcc.thinking, thought: true};
        if (thinkingAcc.signature) {
          part.thoughtSignature = thinkingAcc.signature;
        }
        allParts.push(part);
      }
      const redactedData = redactedThinkingBlocks.get(index);
      if (redactedData !== undefined) {
        allParts.push({thought: true, thoughtSignature: redactedData});
      }
      const textAcc = textBlocks.get(index);
      if (textAcc !== undefined) {
        allParts.push({text: textAcc});
      }
      const toolUseAcc = toolUseBlocks.get(index);
      if (toolUseAcc) {
        const args = toolUseAcc.argsJson
          ? (JSON.parse(toolUseAcc.argsJson) as Record<string, unknown>)
          : {};
        allParts.push({
          functionCall: {id: toolUseAcc.id, name: toolUseAcc.name, args},
        });
      }
    }

    yield {
      content: {role: 'model', parts: allParts},
      usageMetadata: buildUsageMetadata(
        inputTokens,
        outputTokens,
        cachedInputTokens,
      ),
      finishReason: toGoogleGenaiFinishReason(stopReason),
      partial: false,
    };
  }

  private resolveModelName(model?: string): string {
    if (!model) {
      return this.model;
    }
    if (model.startsWith('projects/')) {
      const match = model.match(
        /projects\/[^/]+\/locations\/[^/]+\/(?:publishers\/anthropic\/models|endpoints)\/([^/:]+)/,
      );
      if (match) {
        return match[1];
      }
    }
    return model;
  }
}

/**
 * Integration with Claude models served from Vertex AI.
 *
 * A bare Claude model name resolves to this class via {@link LLMRegistry}. The
 * Vertex client reads `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` (or a
 * full `projects/.../locations/...` model string) and forwards tracking headers.
 */
export class Claude extends AnthropicLlm {
  /**
   * @param params The parameters for creating a Claude instance.
   */
  constructor(params: AnthropicLlmParams = {}) {
    super({...params, model: params.model ?? DEFAULT_CLAUDE_VERTEX_MODEL});
  }

  protected override createAnthropicClient(): AnthropicMessagesClient {
    let projectId = this.project ?? process.env['GOOGLE_CLOUD_PROJECT'];
    let location = this.location ?? process.env['GOOGLE_CLOUD_LOCATION'];

    if (this.model.startsWith('projects/')) {
      const match = this.model.match(/projects\/([^/]+)\/locations\/([^/]+)\//);
      if (match) {
        projectId = match[1];
        location = match[2];
      }
    }

    if (!projectId || !location) {
      throw new Error(
        'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set for using ' +
          'Anthropic on Vertex.',
      );
    }

    return new AnthropicVertex({
      projectId,
      region: location,
      defaultHeaders: this.trackingHeaders,
    });
  }
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

function getOrCreateThinking(
  thinkingBlocks: Map<number, ThinkingAccumulator>,
  index: number,
): ThinkingAccumulator {
  let acc = thinkingBlocks.get(index);
  if (!acc) {
    acc = {thinking: '', signature: ''};
    thinkingBlocks.set(index, acc);
  }
  return acc;
}

function buildUsageMetadata(
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number | undefined,
): GenerateContentResponseUsageMetadata {
  return {
    promptTokenCount: inputTokens,
    candidatesTokenCount: outputTokens,
    totalTokenCount: inputTokens + outputTokens,
    cachedContentTokenCount: cachedTokens,
  };
}

function extractCachedTokenCount(usage: {
  cache_read_input_tokens?: number | null;
}): number | undefined {
  const cached = usage.cache_read_input_tokens;
  return typeof cached === 'number' ? cached : undefined;
}

function isImagePart(part: Part): boolean {
  return part.inlineData?.mimeType?.startsWith('image') ?? false;
}

function isPdfPart(part: Part): boolean {
  const mimeType = part.inlineData?.mimeType;
  return !!mimeType && mimeType.split(';')[0].trim() === 'application/pdf';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepCopyToPlainObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function extractFunctionResponseContent(
  response?: Record<string, unknown>,
): string {
  const responseData = response ?? {};
  const contentValue = responseData['content'];

  if (Array.isArray(contentValue) && contentValue.length > 0) {
    const items = contentValue.map((item) => {
      if (isPlainObject(item) && item['type'] === 'text' && 'text' in item) {
        return String(item['text']);
      }
      return typeof item === 'object' && item !== null
        ? JSON.stringify(item)
        : String(item);
    });
    return items.join('\n');
  }

  if (typeof contentValue === 'string' && contentValue) {
    return contentValue;
  }

  const resultValue = responseData['result'];
  if (resultValue !== undefined && resultValue !== null) {
    return typeof resultValue === 'object'
      ? JSON.stringify(resultValue)
      : String(resultValue);
  }

  if (Object.keys(responseData).length > 0) {
    return JSON.stringify(responseData);
  }

  return '';
}

/**
 * Converts a single genai part to an Anthropic content block.
 *
 * @param part The genai part.
 * @param sanitizer Tool-id sanitizer; pass a shared instance to keep a
 *   `tool_use` block and its paired `tool_result` id consistent across a
 *   conversation. Defaults to a fresh, single-use sanitizer.
 * @returns The Anthropic content block param.
 */
export function partToMessageBlock(
  part: Part,
  sanitizer: ToolUseIdSanitizer = new ToolUseIdSanitizer(),
): Anthropic.ContentBlockParam {
  if (part.thought && part.text) {
    return {
      type: 'thinking',
      thinking: part.text,
      signature: part.thoughtSignature ?? '',
    };
  }
  if (part.thought && part.thoughtSignature) {
    // Redacted thinking: no plaintext, only the encrypted blob for round-trips.
    return {type: 'redacted_thinking', data: part.thoughtSignature};
  }
  if (part.text) {
    return {type: 'text', text: part.text};
  }
  if (part.functionCall) {
    if (!part.functionCall.name) {
      throw new Error('Function call must have a name.');
    }
    return {
      type: 'tool_use',
      id: sanitizer.sanitize(part.functionCall.id),
      name: part.functionCall.name,
      input: part.functionCall.args ?? {},
    };
  }
  if (part.functionResponse) {
    return {
      type: 'tool_result',
      tool_use_id: sanitizer.sanitize(part.functionResponse.id),
      content: extractFunctionResponseContent(part.functionResponse.response),
      is_error: false,
    };
  }
  if (isImagePart(part)) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: part.inlineData!
          .mimeType as Anthropic.Base64ImageSource['media_type'],
        data: part.inlineData!.data!,
      },
    };
  }
  if (isPdfPart(part)) {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: part.inlineData!
          .mimeType as Anthropic.Base64PDFSource['media_type'],
        data: part.inlineData!.data!,
      },
    };
  }
  if (part.executableCode) {
    return {
      type: 'text',
      text: 'Code:```python\n' + (part.executableCode.code ?? '') + '\n```',
    };
  }
  if (part.codeExecutionResult) {
    return {
      type: 'text',
      text:
        'Execution Result:```code_output\n' +
        (part.codeExecutionResult.output ?? '') +
        '\n```',
    };
  }

  throw new Error(`Not supported yet: ${JSON.stringify(part)}`);
}

/**
 * Converts a genai content to an Anthropic message param.
 *
 * @param content The genai content.
 * @param sanitizer Tool-id sanitizer; pass a shared instance to keep tool ids
 *   consistent across a conversation. Defaults to a fresh, single-use
 *   sanitizer.
 * @returns The Anthropic message param.
 */
export function contentToMessageParam(
  content: Content,
  sanitizer: ToolUseIdSanitizer = new ToolUseIdSanitizer(),
): Anthropic.MessageParam {
  const messageBlocks: Anthropic.ContentBlockParam[] = [];
  for (const part of content.parts ?? []) {
    // Image and PDF data are not supported in Claude for assistant turns.
    if (content.role !== 'user' && isImagePart(part)) {
      logger.warn('Image data is not supported in Claude for assistant turns.');
      continue;
    }
    if (content.role !== 'user' && isPdfPart(part)) {
      logger.warn('PDF data is not supported in Claude for assistant turns.');
      continue;
    }
    messageBlocks.push(partToMessageBlock(part, sanitizer));
  }

  return {role: toClaudeRole(content.role), content: messageBlocks};
}
