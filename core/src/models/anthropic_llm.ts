/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Anthropic integration for Claude models.
 *
 * Speaks the native Anthropic Messages API (`POST /v1/messages`) wire format
 * directly over the built-in `fetch` API, without a vendor SDK. It translates
 * between the ADK / `@google/genai` content model and the Anthropic Messages
 * HTTP request/response shapes.
 */

import {
  Content,
  FinishReason,
  FunctionDeclaration,
  GenerateContentConfig,
  Part,
  Tool,
} from '@google/genai';

import {logger} from '../utils/logger.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {extractSystemInstruction} from './interactions_utils.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/** The Anthropic API version pinned for every request (`anthropic-version`). */
const ANTHROPIC_VERSION = '2023-06-01';

/** Default Claude model, matching the adk-python provider. */
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/** Default `max_tokens`, matching the adk-python provider. */
const DEFAULT_MAX_TOKENS = 8192;

/** Default Anthropic API base URL. */
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** The Messages API endpoint path. */
const MESSAGES_PATH = '/v1/messages';

/** Environment variable read for the API key when none is passed explicitly. */
const API_KEY_ENV_VARIABLE_NAME = 'ANTHROPIC_API_KEY';

// --- Anthropic Messages API wire-format types (request side) ---

/** Anthropic `text` content block (request). */
export interface AnthropicTextBlockParam {
  type: 'text';
  text: string;
}

/** Anthropic `thinking` content block (request). */
export interface AnthropicThinkingBlockParam {
  type: 'thinking';
  thinking: string;
  signature: string;
}

/** Anthropic `redacted_thinking` content block (request). */
export interface AnthropicRedactedThinkingBlockParam {
  type: 'redacted_thinking';
  data: string;
}

/** Anthropic base64 media source shared by image and document blocks. */
export interface AnthropicBase64Source {
  type: 'base64';
  media_type: string;
  data: string;
}

/** Anthropic `image` content block (request). */
export interface AnthropicImageBlockParam {
  type: 'image';
  source: AnthropicBase64Source;
}

/** Anthropic `document` content block (request). */
export interface AnthropicDocumentBlockParam {
  type: 'document';
  source: AnthropicBase64Source;
}

/** Anthropic `tool_use` content block (request). */
export interface AnthropicToolUseBlockParam {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Anthropic `tool_result` content block (request). */
export interface AnthropicToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

/** Union of all Anthropic request-side content blocks. */
export type AnthropicContentBlockParam =
  | AnthropicTextBlockParam
  | AnthropicThinkingBlockParam
  | AnthropicRedactedThinkingBlockParam
  | AnthropicImageBlockParam
  | AnthropicDocumentBlockParam
  | AnthropicToolUseBlockParam
  | AnthropicToolResultBlockParam;

/** Anthropic message (request). */
export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: AnthropicContentBlockParam[];
}

/** Anthropic tool definition (request). */
export interface AnthropicToolParam {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Anthropic thinking parameter (request). */
export type AnthropicThinkingParam =
  | {type: 'enabled'; budget_tokens: number}
  | {type: 'disabled'}
  | {type: 'adaptive'};

/** The Anthropic Messages API `POST /v1/messages` request body (internal). */
interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessageParam[];
  system?: string;
  tools?: AnthropicToolParam[];
  tool_choice?: {type: 'auto'};
  thinking?: AnthropicThinkingParam;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  output_config?: {effort: string};
  stream?: boolean;
}

// --- Anthropic Messages API wire-format types (response side) ---

/** Anthropic `text` content block (response). */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

/** Anthropic `thinking` content block (response). */
export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

/** Anthropic `redacted_thinking` content block (response). */
export interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

/** Anthropic `tool_use` content block (response). */
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Union of all Anthropic response-side content blocks. */
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock;

/** Anthropic token usage (response). */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
}

/** The Anthropic Messages API non-streaming response body. */
export interface AnthropicMessage {
  id: string;
  model: string;
  role: 'assistant';
  stop_reason: string | null;
  stop_sequence: string | null;
  type: 'message';
  content: AnthropicContentBlock[];
  usage: AnthropicUsage;
}

// --- Anthropic Messages API streaming (SSE) event types ---

/** Delta payloads carried by `content_block_delta` events (internal). */
type AnthropicStreamDelta =
  | {type: 'text_delta'; text: string}
  | {type: 'thinking_delta'; thinking: string}
  | {type: 'signature_delta'; signature: string}
  | {type: 'input_json_delta'; partial_json: string};

/** Discriminated union of Anthropic streaming SSE events (internal). */
type AnthropicStreamEvent =
  | {type: 'message_start'; message: {usage: AnthropicUsage}}
  | {
      type: 'content_block_start';
      index: number;
      content_block: AnthropicContentBlock;
    }
  | {type: 'content_block_delta'; index: number; delta: AnthropicStreamDelta}
  | {type: 'content_block_stop'; index: number}
  | {
      type: 'message_delta';
      delta: {stop_reason: string | null};
      usage: {output_tokens: number};
    }
  | {type: 'message_stop'}
  | {type: 'ping'};

// --- Public config / params ---

/**
 * Configuration options for Anthropic Claude content generation.
 *
 * This specialized configuration is the recommended way to configure reasoning
 * and extended thinking for newer Claude models.
 */
export interface AnthropicGenerateContentConfig extends GenerateContentConfig {
  /**
   * The reasoning effort level for adaptive extended thinking. Set directly to
   * guide the reasoning depth. This is the preferred, future-proof alternative
   * to the deprecated manual `thinkingConfig.thinkingBudget` on newer Claude
   * models.
   *
   * The standard `thinkingConfig.thinkingLevel` is not supported for Anthropic
   * models and is ignored (its 4 levels cannot map consistently to Anthropic's
   * 5 effort levels).
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/** Constructor parameters for {@link AnthropicLlm}. */
export interface AnthropicLlmParams {
  /** The Claude model name. Defaults to `claude-sonnet-4-20250514`. */
  model?: string;
  /**
   * The Anthropic API key. Falls back to the `ANTHROPIC_API_KEY` environment
   * variable when omitted.
   */
  apiKey?: string;
  /** The maximum number of tokens to generate. Defaults to `8192`. */
  maxTokens?: number;
  /**
   * The Anthropic API base URL. Defaults to `https://api.anthropic.com`. Useful
   * for testing or proxying.
   */
  baseUrl?: string;
}

// --- Module-level helpers (camelCase ports of the adk-python originals) ---

/** Maps Anthropic stop reasons to genai finish reasons. */
export const STOP_REASON_MAPPING: Record<string, FinishReason> = {
  end_turn: FinishReason.STOP,
  stop_sequence: FinishReason.STOP,
  tool_use: FinishReason.STOP,
  pause_turn: FinishReason.STOP,
  max_tokens: FinishReason.MAX_TOKENS,
  refusal: FinishReason.SAFETY,
};

/** Converts a genai content role to an Anthropic message role. */
export function toClaudeRole(role?: string): 'user' | 'assistant' {
  return role === 'model' || role === 'assistant' ? 'assistant' : 'user';
}

/**
 * Maps an Anthropic stop reason to a genai `FinishReason`.
 *
 * Returns `undefined` for `null`/absent reasons and
 * `FINISH_REASON_UNSPECIFIED` for unrecognized ones.
 */
export function toGoogleGenAIFinishReason(
  stopReason?: string | null,
): FinishReason | undefined {
  if (stopReason === null || stopReason === undefined) {
    return undefined;
  }
  return (
    STOP_REASON_MAPPING[stopReason] ?? FinishReason.FINISH_REASON_UNSPECIFIED
  );
}

/** True when the part carries inline image data. */
export function isImagePart(part: Part): boolean {
  return !!part.inlineData?.mimeType?.startsWith('image');
}

/** True when the part carries an inline PDF document. */
export function isPdfPart(part: Part): boolean {
  const mimeType = part.inlineData?.mimeType;
  return !!mimeType && mimeType.split(';')[0].trim() === 'application/pdf';
}

/**
 * Maps invalid tool_use IDs to deterministic fallbacks.
 *
 * Reuse one instance per conversation so a `tool_use` and its paired
 * `tool_result` with the same invalid source ID get matching outputs.
 */
export class ToolUseIdSanitizer {
  private readonly mapping = new Map<string, string>();
  private nextFallback = 0;

  sanitize(toolId?: string | null): string {
    if (toolId && /^[a-zA-Z0-9_-]+$/.test(toolId)) {
      return toolId;
    }
    const key = toolId ?? '';
    let fallback = this.mapping.get(key);
    if (fallback === undefined) {
      fallback = `toolu_fallback_${this.nextFallback++}`;
      this.mapping.set(key, fallback);
    }
    return fallback;
  }
}

/** Serializes a `functionResponse.response` payload to Anthropic tool_result text. */
function functionResponseToContent(
  response: Record<string, unknown> | undefined,
): string {
  const responseData = response ?? {};
  const contentValue = responseData['content'];

  if (Array.isArray(contentValue) && contentValue.length > 0) {
    const contentItems = contentValue.map((item) => {
      if (
        item !== null &&
        typeof item === 'object' &&
        (item as {type?: unknown}).type === 'text' &&
        'text' in item
      ) {
        return String((item as {text: unknown}).text);
      }
      return String(item);
    });
    return contentItems.join('\n');
  }

  if (typeof contentValue === 'string' && contentValue) {
    return contentValue;
  }

  const resultValue = responseData['result'];
  if (resultValue !== null && resultValue !== undefined) {
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
 * Converts a single genai `Part` to an Anthropic content block.
 *
 * Pass a shared {@link ToolUseIdSanitizer} to keep `tool_use`/`tool_result` IDs
 * paired across a conversation; when omitted, each call uses a fresh one.
 */
export function partToMessageBlock(
  part: Part,
  sanitizer: ToolUseIdSanitizer = new ToolUseIdSanitizer(),
): AnthropicContentBlockParam {
  if (part.thought && part.text) {
    return {
      type: 'thinking',
      thinking: part.text,
      signature: part.thoughtSignature ?? '',
    };
  }
  if (part.thought && part.thoughtSignature) {
    return {type: 'redacted_thinking', data: part.thoughtSignature};
  }
  if (part.text) {
    return {type: 'text', text: part.text};
  }
  if (part.functionCall) {
    if (!part.functionCall.name) {
      throw new Error('function_call.name is required for tool_use.');
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
      content: functionResponseToContent(part.functionResponse.response),
      is_error: false,
    };
  }
  if (isImagePart(part)) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: part.inlineData!.mimeType!,
        data: part.inlineData!.data ?? '',
      },
    };
  }
  if (isPdfPart(part)) {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: part.inlineData!.mimeType!,
        data: part.inlineData!.data ?? '',
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
 * Converts a genai `Content` to an Anthropic message.
 *
 * Pass a shared {@link ToolUseIdSanitizer} to keep tool IDs paired across a
 * conversation; when omitted, each call uses a fresh one.
 */
export function contentToMessageParam(
  content: Content,
  sanitizer: ToolUseIdSanitizer = new ToolUseIdSanitizer(),
): AnthropicMessageParam {
  const messageBlock: AnthropicContentBlockParam[] = [];
  for (const part of content.parts ?? []) {
    // Image and PDF data are not supported on Claude assistant turns.
    if (content.role !== 'user' && isImagePart(part)) {
      logger.warn('Image data is not supported in Claude for assistant turns.');
      continue;
    }
    if (content.role !== 'user' && isPdfPart(part)) {
      logger.warn('PDF data is not supported in Claude for assistant turns.');
      continue;
    }
    messageBlock.push(partToMessageBlock(part, sanitizer));
  }

  return {role: toClaudeRole(content.role), content: messageBlock};
}

/** Converts an Anthropic response content block to a genai `Part`. */
export function contentBlockToPart(block: AnthropicContentBlock): Part {
  switch (block.type) {
    case 'thinking': {
      const part: Part = {text: block.thinking, thought: true};
      if (block.signature) {
        part.thoughtSignature = block.signature;
      }
      return part;
    }
    case 'redacted_thinking':
      // Preserve the encrypted blob so it can round-trip back to Claude on the
      // next turn, keeping the model's reasoning chain intact.
      return {thought: true, thoughtSignature: block.data};
    case 'text':
      return {text: block.text};
    case 'tool_use':
      return {
        functionCall: {id: block.id, name: block.name, args: block.input},
      };
    default:
      throw new Error(
        `Unsupported content block type: ${JSON.stringify(block)}`,
      );
  }
}

/** Returns the Anthropic cache-read token count, the analog of cached tokens. */
export function extractCachedTokenCount(
  usage: AnthropicUsage,
): number | undefined {
  const cached = usage.cache_read_input_tokens;
  return typeof cached === 'number' ? cached : undefined;
}

/** Converts an Anthropic non-streaming message to an `LlmResponse`. */
export function messageToGenerateContentResponse(
  message: AnthropicMessage,
): LlmResponse {
  logger.info('Received response from Claude.');

  const parts = message.content.map(contentBlockToPart);

  return {
    content: {role: 'model', parts},
    usageMetadata: {
      promptTokenCount: message.usage.input_tokens,
      candidatesTokenCount: message.usage.output_tokens,
      totalTokenCount: message.usage.input_tokens + message.usage.output_tokens,
      cachedContentTokenCount: extractCachedTokenCount(message.usage),
    },
    finishReason: toGoogleGenAIFinishReason(message.stop_reason),
  };
}

/** Recursively lowercases nested JSON schema `type` strings for Anthropic. */
export function updateTypeString(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      updateTypeString(item);
    }
    return;
  }
  if (value === null || typeof value !== 'object') {
    return;
  }

  const schema = value as Record<string, unknown>;
  if (typeof schema['type'] === 'string') {
    schema['type'] = (schema['type'] as string).toLowerCase();
  }

  for (const dictKey of [
    '$defs',
    'defs',
    'dependentSchemas',
    'patternProperties',
    'properties',
  ]) {
    const child = schema[dictKey];
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      for (const childValue of Object.values(
        child as Record<string, unknown>,
      )) {
        updateTypeString(childValue);
      }
    }
  }

  for (const singleKey of [
    'additionalProperties',
    'additional_properties',
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

  for (const listKey of [
    'allOf',
    'all_of',
    'anyOf',
    'any_of',
    'oneOf',
    'one_of',
    'prefixItems',
  ]) {
    const child = schema[listKey];
    if (Array.isArray(child)) {
      updateTypeString(child);
    }
  }
}

/** Deep-clones a value while dropping `null`/`undefined` entries (exclude_none). */
function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cleanSchema);
  }
  if (value !== null && typeof value === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (entry !== null && entry !== undefined) {
        cleaned[key] = cleanSchema(entry);
      }
    }
    return cleaned;
  }
  return value;
}

/** Converts a genai `FunctionDeclaration` to an Anthropic tool parameter. */
export function functionDeclarationToToolParam(
  functionDeclaration: FunctionDeclaration,
): AnthropicToolParam {
  if (!functionDeclaration.name) {
    throw new Error('function_declaration.name is required.');
  }

  let inputSchema: Record<string, unknown>;
  if (functionDeclaration.parametersJsonSchema) {
    inputSchema = structuredClone(
      functionDeclaration.parametersJsonSchema,
    ) as Record<string, unknown>;
    updateTypeString(inputSchema);
  } else {
    const properties: Record<string, unknown> = {};
    const requiredParams: string[] = [];
    const parameters = functionDeclaration.parameters;
    if (parameters) {
      if (parameters.properties) {
        for (const [key, value] of Object.entries(parameters.properties)) {
          properties[key] = cleanSchema(value);
        }
      }
      if (parameters.required) {
        requiredParams.push(...parameters.required);
      }
    }
    inputSchema = {type: 'object', properties};
    if (requiredParams.length > 0) {
      inputSchema['required'] = requiredParams;
    }
    updateTypeString(inputSchema);
  }

  return {
    name: functionDeclaration.name,
    description: functionDeclaration.description || '',
    input_schema: inputSchema,
  };
}

/**
 * Maps a genai `ThinkingConfig` to an Anthropic thinking parameter.
 *
 * `thinkingBudget` semantics: `undefined` throws (an explicit choice is
 * required); `0` disables thinking; a negative value selects adaptive thinking
 * (model-chosen depth); a positive value sets a manual token budget.
 */
export function buildAnthropicThinkingParam(
  config?: GenerateContentConfig,
): AnthropicThinkingParam | undefined {
  if (!config || !config.thinkingConfig) {
    return undefined;
  }

  const thinkingBudget = config.thinkingConfig.thinkingBudget;

  if (thinkingBudget === null || thinkingBudget === undefined) {
    throw new Error(
      'thinking_budget must be set explicitly when ThinkingConfig is provided' +
        ' for Anthropic models. Use 0 to disable thinking, -1 for adaptive' +
        ' (model-chosen depth), or a positive integer (>= 1024) for manual' +
        ' budgeting.',
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
 * Extracts the Anthropic `effort` parameter from the configuration.
 *
 * Callers must use {@link AnthropicGenerateContentConfig} and set `effort`
 * directly. The standard `thinkingConfig.thinkingLevel` is unsupported: if set
 * (without `effort`), a warning is logged and it is ignored.
 */
export function buildEffortParam(
  config?: GenerateContentConfig,
): string | undefined {
  if (!config) {
    return undefined;
  }

  const effort = (config as AnthropicGenerateContentConfig).effort;
  if (effort) {
    return effort;
  }

  if (config.thinkingConfig?.thinkingLevel) {
    logger.warn(
      'Standard thinking_config.thinking_level is not supported for Anthropic' +
        ' models and will be ignored. Use AnthropicGenerateContentConfig and' +
        ' set the `effort` field directly to configure reasoning effort.',
    );
  }

  return undefined;
}

/** Accumulates a streamed `tool_use` content block. */
interface ToolUseAccumulator {
  id: string;
  name: string;
  argsJson: string;
}

/** Accumulates a streamed `thinking` content block. */
interface ThinkingAccumulator {
  thinking: string;
  signature: string;
}

/** Extracts the concatenated `data:` payload from a raw SSE event block. */
function extractSseData(rawEvent: string): string | null {
  const dataLines: string[] = [];
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null;
}

/** Parses an SSE byte stream into a sequence of Anthropic stream events. */
async function* parseSseStream(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<AnthropicStreamEvent, void> {
  if (!body) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {stream: true}).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = extractSseData(rawEvent);
        if (data) {
          yield JSON.parse(data) as AnthropicStreamEvent;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }

    const data = extractSseData(buffer);
    if (data) {
      yield JSON.parse(data) as AnthropicStreamEvent;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Integration with Claude models via the Anthropic Messages API over `fetch`.
 *
 * Anthropic Claude supports 5 effort levels ("low", "medium", "high", "xhigh",
 * "max") while the standard `thinkingConfig.thinkingLevel` enum defines 4, so
 * `thinkingLevel` is not supported for Anthropic models. To configure thinking
 * effort, use {@link AnthropicGenerateContentConfig} and set its `effort` field
 * directly (e.g. `effort: 'xhigh'`).
 */
export class AnthropicLlm extends BaseLlm {
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly baseUrl: string;

  /** List of model name patterns supported by this LLM (for the registry). */
  static override readonly supportedModels: Array<string | RegExp> = [
    /claude-3-.*/,
    /claude-.*-4.*/,
  ];

  constructor(params: AnthropicLlmParams = {}) {
    super({model: params.model ?? DEFAULT_MODEL});

    const apiKey = params.apiKey ?? process.env[API_KEY_ENV_VARIABLE_NAME];
    if (!apiKey) {
      throw new Error(
        'API key must be provided via the constructor or the' +
          ` ${API_KEY_ENV_VARIABLE_NAME} environment variable.`,
      );
    }
    this.apiKey = apiKey;
    this.maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.baseUrl = params.baseUrl ?? DEFAULT_BASE_URL;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const sanitizer = new ToolUseIdSanitizer();
    const messages = (llmRequest.contents ?? []).map((content) =>
      contentToMessageParam(content, sanitizer),
    );

    let tools: AnthropicToolParam[] | undefined;
    const configTools = llmRequest.config?.tools as Tool[] | undefined;
    if (configTools?.[0]?.functionDeclarations) {
      tools = configTools[0].functionDeclarations.map(
        functionDeclarationToToolParam,
      );
    }

    const toolChoice =
      Object.keys(llmRequest.toolsDict ?? {}).length > 0
        ? ({type: 'auto'} as const)
        : undefined;
    const thinking = buildAnthropicThinkingParam(llmRequest.config);

    const body = this.buildRequestBody(
      llmRequest,
      messages,
      tools,
      toolChoice,
      thinking,
    );

    if (!stream) {
      yield* this.generateNonStreaming(body, abortSignal);
    } else {
      yield* this.generateStreaming(body, abortSignal);
    }
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('Live connection is not supported for AnthropicLlm.');
  }

  private buildRequestBody(
    llmRequest: LlmRequest,
    messages: AnthropicMessageParam[],
    tools: AnthropicToolParam[] | undefined,
    toolChoice: {type: 'auto'} | undefined,
    thinking: AnthropicThinkingParam | undefined,
  ): AnthropicMessagesRequest {
    const config = llmRequest.config;
    const body: AnthropicMessagesRequest = {
      model: llmRequest.model ?? this.model,
      max_tokens: config?.maxOutputTokens ?? this.maxTokens,
      messages,
    };

    if (config) {
      const system = extractSystemInstruction(config);
      if (system) {
        body.system = system;
      }
    }
    if (tools) {
      body.tools = tools;
    }
    if (toolChoice) {
      body.tool_choice = toolChoice;
    }
    if (thinking) {
      body.thinking = thinking;
    }

    const effort = buildEffortParam(config);
    if (effort) {
      body.output_config = {effort};
    }

    // Models released after Claude Opus 4.6 reject sampling parameters when
    // thinking or effort is enabled.
    const thinkingEnabled =
      thinking?.type === 'enabled' || thinking?.type === 'adaptive';
    const excludeSampling = thinkingEnabled || effort !== undefined;

    if (config) {
      if (!excludeSampling) {
        if (config.temperature !== undefined && config.temperature !== null) {
          body.temperature = config.temperature;
        }
        if (config.topP !== undefined && config.topP !== null) {
          body.top_p = config.topP;
        }
        if (config.topK !== undefined && config.topK !== null) {
          body.top_k = Math.trunc(config.topK);
        }
      } else if (
        config.temperature !== undefined ||
        config.topP !== undefined ||
        config.topK !== undefined
      ) {
        logger.warn(
          'Sampling parameters (temperature, top_p, top_k) are ignored because' +
            ' thinking/effort is enabled.',
        );
      }

      if (config.stopSequences) {
        body.stop_sequences = config.stopSequences;
      }
    }

    return body;
  }

  private async postMessages(
    body: AnthropicMessagesRequest,
    abortSignal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      ...this.trackingHeaders,
    };

    const response = await globalThis.fetch(`${this.baseUrl}${MESSAGES_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `Anthropic API request failed with status ${response.status}: ${errorBody}`,
      );
    }
    return response;
  }

  private async *generateNonStreaming(
    body: AnthropicMessagesRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const response = await this.postMessages(body, abortSignal);
    const message = (await response.json()) as AnthropicMessage;
    yield messageToGenerateContentResponse(message);
  }

  private async *generateStreaming(
    body: AnthropicMessagesRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const response = await this.postMessages(
      {...body, stream: true},
      abortSignal,
    );

    // Track content blocks being built during streaming, keyed by block index.
    const textBlocks = new Map<number, string>();
    const toolUseBlocks = new Map<number, ToolUseAccumulator>();
    const thinkingBlocks = new Map<number, ThinkingAccumulator>();
    const redactedThinkingBlocks = new Map<number, string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens: number | undefined;
    let stopReason: string | null | undefined;

    for await (const event of parseSseStream(response.body)) {
      switch (event.type) {
        case 'message_start':
          inputTokens = event.message.usage.input_tokens;
          outputTokens = event.message.usage.output_tokens;
          cachedInputTokens = extractCachedTokenCount(event.message.usage);
          break;
        case 'content_block_start': {
          const block = event.content_block;
          if (block.type === 'thinking') {
            thinkingBlocks.set(event.index, {
              thinking: block.thinking,
              signature: block.signature,
            });
          } else if (block.type === 'redacted_thinking') {
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
          break;
        }
        case 'content_block_delta': {
          const delta = event.delta;
          if (delta.type === 'thinking_delta') {
            const acc = thinkingBlocks.get(event.index) ?? {
              thinking: '',
              signature: '',
            };
            acc.thinking += delta.thinking;
            thinkingBlocks.set(event.index, acc);
            yield {
              content: {
                role: 'model',
                parts: [{text: delta.thinking, thought: true}],
              },
              partial: true,
            };
          } else if (delta.type === 'signature_delta') {
            const acc = thinkingBlocks.get(event.index) ?? {
              thinking: '',
              signature: '',
            };
            acc.signature += delta.signature;
            thinkingBlocks.set(event.index, acc);
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
          break;
        }
        case 'message_delta':
          stopReason = event.delta.stop_reason;
          outputTokens = event.usage.output_tokens;
          break;
        default:
          // content_block_stop, message_stop, ping and unknown events: ignore.
          break;
      }
    }

    yield this.buildAggregatedResponse(
      thinkingBlocks,
      redactedThinkingBlocks,
      textBlocks,
      toolUseBlocks,
      {inputTokens, outputTokens, cachedInputTokens, stopReason},
    );
  }

  private buildAggregatedResponse(
    thinkingBlocks: Map<number, ThinkingAccumulator>,
    redactedThinkingBlocks: Map<number, string>,
    textBlocks: Map<number, string>,
    toolUseBlocks: Map<number, ToolUseAccumulator>,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number | undefined;
      stopReason: string | null | undefined;
    },
  ): LlmResponse {
    const allIndices = [
      ...new Set([
        ...thinkingBlocks.keys(),
        ...redactedThinkingBlocks.keys(),
        ...textBlocks.keys(),
        ...toolUseBlocks.keys(),
      ]),
    ].sort((a, b) => a - b);

    const allParts: Part[] = [];
    for (const index of allIndices) {
      const thinking = thinkingBlocks.get(index);
      if (thinking) {
        const part: Part = {text: thinking.thinking, thought: true};
        if (thinking.signature) {
          part.thoughtSignature = thinking.signature;
        }
        allParts.push(part);
      }
      const redacted = redactedThinkingBlocks.get(index);
      if (redacted !== undefined) {
        allParts.push({thought: true, thoughtSignature: redacted});
      }
      const text = textBlocks.get(index);
      if (text !== undefined) {
        allParts.push({text});
      }
      const toolUse = toolUseBlocks.get(index);
      if (toolUse) {
        const args = toolUse.argsJson
          ? (JSON.parse(toolUse.argsJson) as Record<string, unknown>)
          : {};
        allParts.push({
          functionCall: {id: toolUse.id, name: toolUse.name, args},
        });
      }
    }

    return {
      content: {role: 'model', parts: allParts},
      usageMetadata: {
        promptTokenCount: usage.inputTokens,
        candidatesTokenCount: usage.outputTokens,
        totalTokenCount: usage.inputTokens + usage.outputTokens,
        cachedContentTokenCount: usage.cachedInputTokens,
      },
      finishReason: toGoogleGenAIFinishReason(usage.stopReason),
      partial: false,
    };
  }
}
