/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conversions between genai content and Anthropic message blocks.
 *
 * The two representations differ in three ways that matter here. Claude has
 * only a `user` and an `assistant` role, so every other genai role collapses
 * onto `user`. Claude carries a tool result as a block of the *user* turn
 * keyed by the tool-use id, so a call and its answer must agree on that id.
 * And Claude reports cached and cache-write input tokens beside
 * `input_tokens`, while genai expects one prompt count with the cached
 * portion folded in.
 */

import type {Anthropic} from '@anthropic-ai/sdk';
import {
  Content,
  FinishReason,
  FunctionDeclaration,
  FunctionResponse,
  GenerateContentResponseUsageMetadata,
  Part,
  Schema,
} from '@google/genai';

import {logger} from '../utils/logger.js';

import {LlmResponse} from './llm_response.js';

/** The block types this module produces for a message turn. */
export type AnthropicMessageBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ThinkingBlockParam
  | Anthropic.RedactedThinkingBlockParam
  | Anthropic.ImageBlockParam
  | Anthropic.DocumentBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam;

/** The subset of block types Claude accepts inside a tool result. */
type ToolResultContentBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ImageBlockParam
  | Anthropic.DocumentBlockParam;

/** The image media types Claude accepts. */
type AnthropicImageMediaType = Anthropic.Base64ImageSource['media_type'];

const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const PDF_MEDIA_TYPE = 'application/pdf';

/** Tool-use ids Anthropic accepts verbatim. */
const VALID_TOOL_USE_ID = /^[a-zA-Z0-9_-]+$/;

const STOP_REASON_MAPPING: ReadonlyMap<Anthropic.StopReason, FinishReason> =
  new Map([
    ['end_turn', FinishReason.STOP],
    ['stop_sequence', FinishReason.STOP],
    ['tool_use', FinishReason.STOP],
    ['pause_turn', FinishReason.STOP],
    ['max_tokens', FinishReason.MAX_TOKENS],
    ['refusal', FinishReason.SAFETY],
  ]);

/** JSON-schema keys whose value is a map of sub-schemas. */
const SCHEMA_MAP_KEYS = [
  '$defs',
  'defs',
  'dependentSchemas',
  'patternProperties',
  'properties',
] as const;

/** JSON-schema keys whose value is a single sub-schema. */
const SCHEMA_SINGLE_KEYS = [
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
] as const;

/** JSON-schema keys whose value is a list of sub-schemas. */
const SCHEMA_LIST_KEYS = [
  'allOf',
  'all_of',
  'anyOf',
  'any_of',
  'oneOf',
  'one_of',
  'prefixItems',
] as const;

/**
 * `GenerateContentResponseUsageMetadata` plus Anthropic's cache-write count.
 *
 * genai has no field for tokens written to the prompt cache, so it is declared
 * here rather than dropped.
 */
export interface AnthropicUsageMetadata extends GenerateContentResponseUsageMetadata {
  /** Input tokens billed for writing this turn's prefix into the cache. */
  cacheCreationInputTokens?: number;
}

/** Token counts read off an Anthropic response or a stream. */
export interface AnthropicTokenCounts {
  /** Every input token billed for the turn, cache included. */
  promptTokens: number;
  outputTokens: number;
  /** Extended-thinking tokens, already counted inside `outputTokens`. */
  thinkingTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strips `;` parameters and case from a MIME type. */
function normalizeMediaType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

function isAnthropicImageMediaType(
  mediaType: string,
): mediaType is AnthropicImageMediaType {
  return ANTHROPIC_IMAGE_MEDIA_TYPES.has(mediaType);
}

function isImagePart(part: Part): boolean {
  const mimeType = part.inlineData?.mimeType;
  return mimeType !== undefined && mimeType.startsWith('image/');
}

function isPdfPart(part: Part): boolean {
  const mimeType = part.inlineData?.mimeType;
  return (
    mimeType !== undefined && normalizeMediaType(mimeType) === PDF_MEDIA_TYPE
  );
}

/**
 * Claude's thinking signature is an opaque string; genai carries a thought
 * signature as base64. These two functions are the bridge, and they must stay
 * exact inverses or a signed thinking block cannot round-trip back to Claude.
 */
function encodeThoughtSignature(signature: string): string {
  return Buffer.from(signature, 'utf-8').toString('base64');
}

function decodeThoughtSignature(thoughtSignature: string): string {
  return Buffer.from(thoughtSignature, 'base64').toString('utf-8');
}

/**
 * Maps an ADK role onto one of Claude's two roles.
 *
 * @param role The genai content role.
 * @return `assistant` for a model turn, `user` for everything else.
 */
export function toClaudeRole(role?: string): 'user' | 'assistant' {
  return role === 'model' || role === 'assistant' ? 'assistant' : 'user';
}

/**
 * Maps an Anthropic stop reason onto a genai finish reason.
 *
 * @param stopReason The stop reason Anthropic reported.
 * @return The finish reason, or `undefined` when Anthropic reported none.
 */
export function toGoogleGenAiFinishReason(
  stopReason?: Anthropic.StopReason | null,
): FinishReason | undefined {
  if (!stopReason) {
    return undefined;
  }
  return (
    STOP_REASON_MAPPING.get(stopReason) ??
    FinishReason.FINISH_REASON_UNSPECIFIED
  );
}

/**
 * Allocates a stable Anthropic-safe id for every tool-use id it is shown.
 *
 * Anthropic only accepts `[a-zA-Z0-9_-]+`, and it rejects a request whose
 * `tool_result` names an id no `tool_use` in the same conversation carries.
 * Reuse one instance for a whole request so a call and its answer that share
 * an unusable source id come out sharing one replacement.
 */
export class ToolUseIdSanitizer {
  private readonly mapping = new Map<string, string>();

  /**
   * @param toolId The id the caller supplied, if any.
   * @return `toolId` when Anthropic accepts it, otherwise a memoised fallback.
   */
  sanitize(toolId?: string): string {
    if (toolId && VALID_TOOL_USE_ID.test(toolId)) {
      return toolId;
    }
    const key = toolId ?? '';
    let fallback = this.mapping.get(key);
    if (fallback === undefined) {
      fallback = `toolu_fallback_${this.mapping.size}`;
      this.mapping.set(key, fallback);
    }
    return fallback;
  }
}

/** Renders one item of a `content` array as text. */
function contentItemToText(item: unknown): string {
  if (isRecord(item) && item['type'] === 'text' && 'text' in item) {
    return String(item['text']);
  }
  return isRecord(item) || Array.isArray(item)
    ? JSON.stringify(item)
    : String(item);
}

/**
 * Renders the serializable part of a tool result as the text Claude sees.
 *
 * The last branch matters: a tool that answers with its own key structure,
 * rather than a `content` or `result` key, must not be silently dropped.
 */
function toolResultText(response: Record<string, unknown>): string {
  const content = response['content'];
  if (Array.isArray(content) && content.length > 0) {
    return content.map(contentItemToText).join('\n');
  }
  if (typeof content === 'string' && content) {
    return content;
  }
  const result = response['result'];
  if (result !== undefined && result !== null) {
    return typeof result === 'object' ? JSON.stringify(result) : String(result);
  }
  if (Object.keys(response).length > 0) {
    return JSON.stringify(response);
  }
  return '';
}

/**
 * Converts media a tool attached to its response into tool-result blocks.
 *
 * Media Claude cannot carry in a tool result is dropped with a warning rather
 * than thrown on: the tool that produced it is often third-party code the
 * caller cannot change, and losing one image beats losing the conversation.
 */
function functionResponseMediaBlocks(
  functionResponse: FunctionResponse,
): ToolResultContentBlock[] {
  const blocks: ToolResultContentBlock[] = [];
  for (const responsePart of functionResponse.parts ?? []) {
    const blob = responsePart.inlineData;
    if (!blob?.data || !blob.mimeType) {
      continue;
    }
    const mediaType = normalizeMediaType(blob.mimeType);
    if (isAnthropicImageMediaType(mediaType)) {
      blocks.push({
        type: 'image',
        source: {type: 'base64', media_type: mediaType, data: blob.data},
      });
    } else if (mediaType === PDF_MEDIA_TYPE) {
      blocks.push({
        type: 'document',
        source: {type: 'base64', media_type: PDF_MEDIA_TYPE, data: blob.data},
      });
    } else {
      logger.warn(
        `Dropping tool result media of type ${mediaType}, which Claude ` +
          'cannot receive in a tool result.',
      );
    }
  }
  return blocks;
}

function functionResponseToToolResult(
  functionResponse: FunctionResponse,
  sanitizer: ToolUseIdSanitizer,
): Anthropic.ToolResultBlockParam {
  const text = toolResultText(functionResponse.response ?? {});
  const mediaBlocks = functionResponseMediaBlocks(functionResponse);
  const leadingText: ToolResultContentBlock[] = text
    ? [{type: 'text', text}]
    : [];
  return {
    type: 'tool_result',
    tool_use_id: sanitizer.sanitize(functionResponse.id),
    content: mediaBlocks.length ? [...leadingText, ...mediaBlocks] : text,
    is_error: false,
  };
}

function inlineDataToImageBlock(part: Part): Anthropic.ImageBlockParam {
  const inlineData = part.inlineData;
  if (!inlineData?.data || !inlineData.mimeType) {
    throw new Error('Anthropic image parts require MIME type and data');
  }
  const mediaType = normalizeMediaType(inlineData.mimeType);
  if (!isAnthropicImageMediaType(mediaType)) {
    throw new Error(
      `Unsupported Anthropic image MIME type: ${inlineData.mimeType}`,
    );
  }
  return {
    type: 'image',
    source: {type: 'base64', media_type: mediaType, data: inlineData.data},
  };
}

function inlineDataToDocumentBlock(part: Part): Anthropic.DocumentBlockParam {
  const data = part.inlineData?.data;
  if (!data) {
    throw new Error('Anthropic PDF parts require data');
  }
  return {
    type: 'document',
    source: {type: 'base64', media_type: PDF_MEDIA_TYPE, data},
  };
}

/**
 * Converts one genai part into the Anthropic block that carries it.
 *
 * @param part The part to convert.
 * @param sanitizer Shared across a whole request so tool ids stay paired.
 * @return The Anthropic block.
 * @throws If the part holds something Claude cannot receive.
 */
export function partToMessageBlock(
  part: Part,
  sanitizer: ToolUseIdSanitizer,
): AnthropicMessageBlock {
  if (part.thought && part.text) {
    return {
      type: 'thinking',
      thinking: part.text,
      signature: part.thoughtSignature
        ? decodeThoughtSignature(part.thoughtSignature)
        : '',
    };
  }
  if (part.thought && part.thoughtSignature) {
    return {
      type: 'redacted_thinking',
      data: decodeThoughtSignature(part.thoughtSignature),
    };
  }
  if (part.text) {
    return {type: 'text', text: part.text};
  }
  if (part.functionCall) {
    const {id, name, args} = part.functionCall;
    if (!name) {
      throw new Error('Anthropic tool calls require a function name');
    }
    return {
      type: 'tool_use',
      id: sanitizer.sanitize(id),
      name,
      input: args ?? {},
    };
  }
  if (part.functionResponse) {
    return functionResponseToToolResult(part.functionResponse, sanitizer);
  }
  if (isImagePart(part)) {
    return inlineDataToImageBlock(part);
  }
  if (isPdfPart(part)) {
    return inlineDataToDocumentBlock(part);
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
 * Converts one genai content turn into an Anthropic message.
 *
 * Claude only accepts images and PDFs on a user turn, so media on any other
 * turn is dropped with a warning.
 *
 * @param content The turn to convert.
 * @param sanitizer Shared across a whole request so tool ids stay paired.
 * @return The Anthropic message.
 */
export function contentToMessageParam(
  content: Content,
  sanitizer: ToolUseIdSanitizer,
): Anthropic.MessageParam {
  const blocks: AnthropicMessageBlock[] = [];
  for (const part of content.parts ?? []) {
    if (content.role !== 'user' && isImagePart(part)) {
      logger.warn('Image data is not supported in Claude for assistant turns.');
      continue;
    }
    if (content.role !== 'user' && isPdfPart(part)) {
      logger.warn('PDF data is not supported in Claude for assistant turns.');
      continue;
    }
    blocks.push(partToMessageBlock(part, sanitizer));
  }
  return {role: toClaudeRole(content.role), content: blocks};
}

/**
 * Converts an Anthropic content block back into a genai part.
 *
 * @param block The block Claude returned.
 * @return The equivalent part.
 * @throws If the block type has no genai equivalent.
 */
export function contentBlockToPart(block: Anthropic.ContentBlock): Part {
  switch (block.type) {
    case 'thinking': {
      const part: Part = {text: block.thinking, thought: true};
      if (block.signature) {
        part.thoughtSignature = encodeThoughtSignature(block.signature);
      }
      return part;
    }
    case 'redacted_thinking':
      // The encrypted blob has to travel back to Claude on the next turn or
      // the model's reasoning chain breaks.
      return {
        thought: true,
        thoughtSignature: encodeThoughtSignature(block.data),
      };
    case 'text':
      return {text: block.text};
    case 'tool_use':
      return {
        functionCall: {
          id: block.id,
          name: block.name,
          args: isRecord(block.input) ? block.input : {},
        },
      };
    default:
      throw new Error(`Unsupported content block type: ${block.type}`);
  }
}

/**
 * Reads the token counts off an Anthropic usage report.
 *
 * `promptTokens` folds in the cached and cache-write counts, which Anthropic
 * reports separately from `input_tokens`; `cachedInputTokens` is a breakdown
 * of the total, never an addition to it. The thinking count is clamped to
 * `output_tokens` so subtracting it can never make the candidate count
 * negative.
 *
 * @param usage The usage Anthropic reported.
 * @return The counts, ready for {@link buildUsageMetadata}.
 */
export function extractTokenCounts(
  usage: Anthropic.Usage,
): AnthropicTokenCounts {
  const cachedInputTokens = usage.cache_read_input_tokens ?? undefined;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? undefined;
  return {
    promptTokens:
      usage.input_tokens +
      (cachedInputTokens ?? 0) +
      (cacheCreationTokens ?? 0),
    outputTokens: usage.output_tokens,
    thinkingTokens: extractThinkingTokenCount(usage),
    cachedInputTokens,
    cacheCreationTokens,
  };
}

/**
 * Reads the extended-thinking token count, clamped to the output total.
 *
 * Anthropic counts thinking tokens inside `output_tokens` while genai keeps
 * the thought and candidate counts disjoint, so the caller subtracts this from
 * the output total. The clamp keeps that subtraction non-negative even if the
 * two counters ever disagree.
 *
 * @param usage A full usage report, or the delta a stream reports.
 * @return The thinking tokens, or `undefined` when Anthropic reported none.
 */
export function extractThinkingTokenCount(
  usage: Anthropic.Usage | Anthropic.MessageDeltaUsage,
): number | undefined {
  const thinkingTokens = usage.output_tokens_details?.thinking_tokens;
  return thinkingTokens === undefined
    ? undefined
    : Math.min(thinkingTokens, usage.output_tokens);
}

/**
 * Builds genai usage metadata from Anthropic's token counts.
 *
 * @param counts The counts collected for the turn.
 * @return The usage metadata for the `LlmResponse`.
 */
export function buildUsageMetadata(
  counts: AnthropicTokenCounts,
): AnthropicUsageMetadata {
  return {
    promptTokenCount: counts.promptTokens,
    candidatesTokenCount: counts.outputTokens - (counts.thinkingTokens ?? 0),
    totalTokenCount: counts.promptTokens + counts.outputTokens,
    cachedContentTokenCount: counts.cachedInputTokens,
    thoughtsTokenCount: counts.thinkingTokens,
    cacheCreationInputTokens: counts.cacheCreationTokens,
  };
}

/**
 * Converts a complete Anthropic message into an `LlmResponse`.
 *
 * @param message The message Claude returned.
 * @return The response ADK hands back to the caller.
 */
export function messageToLlmResponse(message: Anthropic.Message): LlmResponse {
  logger.debug('Received response from Claude.');
  return {
    content: {role: 'model', parts: message.content.map(contentBlockToPart)},
    usageMetadata: buildUsageMetadata(extractTokenCounts(message.usage)),
    finishReason: toGoogleGenAiFinishReason(message.stop_reason),
  };
}

/**
 * Lowercases every nested JSON-schema `type` string, in place.
 *
 * genai spells its types `STRING` and `OBJECT`; Anthropic rejects anything but
 * the lowercase JSON-schema spelling.
 *
 * @param value The schema, or a fragment of one, to rewrite.
 */
export function updateTypeString(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      updateTypeString(item);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const schemaType = value['type'];
  if (typeof schemaType === 'string') {
    value['type'] = schemaType.toLowerCase();
  }
  for (const key of SCHEMA_MAP_KEYS) {
    const child = value[key];
    if (isRecord(child)) {
      for (const childValue of Object.values(child)) {
        updateTypeString(childValue);
      }
    }
  }
  for (const key of SCHEMA_SINGLE_KEYS) {
    updateTypeString(value[key]);
  }
  for (const key of SCHEMA_LIST_KEYS) {
    const child = value[key];
    if (Array.isArray(child)) {
      updateTypeString(child);
    }
  }
}

/**
 * Deep-copies a JSON-serializable value into a plain record.
 *
 * The copy exists so that lowercasing types never mutates the caller's
 * declaration; the round trip also drops `undefined` members, matching what
 * reaches the wire.
 */
function cloneJsonObject(value: unknown): Record<string, unknown> {
  const copy: unknown = JSON.parse(JSON.stringify(value));
  return isRecord(copy) ? copy : {};
}

function parametersToInputSchema(parameters?: Schema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parameters?.properties ?? {})) {
    properties[key] = cloneJsonObject(value);
  }
  const schema: Record<string, unknown> = {type: 'object', properties};
  if (parameters?.required?.length) {
    schema['required'] = parameters.required;
  }
  return schema;
}

/**
 * Converts a genai function declaration into an Anthropic tool definition.
 *
 * @param functionDeclaration The declaration to convert.
 * @return The Anthropic tool definition.
 */
export function functionDeclarationToToolParam(
  functionDeclaration: FunctionDeclaration,
): Anthropic.Tool {
  const {name, description, parameters, parametersJsonSchema} =
    functionDeclaration;
  if (!name) {
    throw new Error('Anthropic tool definitions require a function name');
  }
  const inputSchema = parametersJsonSchema
    ? cloneJsonObject(parametersJsonSchema)
    : parametersToInputSchema(parameters);
  updateTypeString(inputSchema);
  return {
    name,
    description: description ?? '',
    input_schema: {...inputSchema, type: 'object'},
  };
}
