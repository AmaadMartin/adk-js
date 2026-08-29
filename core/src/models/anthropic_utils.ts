/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Base64ImageSource,
  ContentBlock,
  DocumentBlockParam,
  ImageBlockParam,
  Message,
  MessageParam,
  OutputConfig,
  RedactedThinkingBlockParam,
  StopReason,
  TextBlockParam,
  ThinkingBlockParam,
  ThinkingConfigParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
  Usage,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  Content,
  ContentUnion,
  FunctionDeclaration,
  FunctionResponse,
  FunctionResponsePart,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';
import {FinishReason} from '@google/genai';

import {genaiSchemaToJsonSchema} from '../utils/genai_schema_to_json.js';
import {logger} from '../utils/logger.js';
import {baseMimeType} from '../utils/mime_utils.js';

import {LlmResponse} from './llm_response.js';

/** A reasoning effort level Anthropic accepts. */
export type AnthropicEffort = NonNullable<OutputConfig['effort']>;

/**
 * A generate-content config extended with Anthropic's reasoning effort.
 *
 * `effort` replaces `thinkingConfig.thinkingLevel`, which Claude does not
 * accept. Setting both is an error.
 */
export interface AnthropicGenerateContentConfig extends GenerateContentConfig {
  /** How much reasoning effort Claude should spend on the turn. */
  effort?: AnthropicEffort | null;
}

/**
 * Maps every Anthropic stop reason onto its genai counterpart.
 *
 * The map is exhaustive on purpose: when the SDK adds a stop reason, this
 * fails to compile rather than silently reporting the wrong finish reason.
 */
const GENAI_FINISH_REASONS: Record<StopReason, FinishReason> = {
  end_turn: FinishReason.STOP,
  stop_sequence: FinishReason.STOP,
  tool_use: FinishReason.STOP,
  pause_turn: FinishReason.STOP,
  max_tokens: FinishReason.MAX_TOKENS,
  refusal: FinishReason.SAFETY,
  model_context_window_exceeded: FinishReason.FINISH_REASON_UNSPECIFIED,
};

/** The Anthropic request blocks a genai `Part` can convert to. */
export type AnthropicMessageBlock =
  | TextBlockParam
  | ThinkingBlockParam
  | RedactedThinkingBlockParam
  | ImageBlockParam
  | DocumentBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam;

/** The media types Anthropic accepts for a base64 image source. */
type AnthropicImageMediaType = Base64ImageSource['media_type'];

const ANTHROPIC_IMAGE_MEDIA_TYPES: readonly AnthropicImageMediaType[] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

const PDF_MIME_TYPE = 'application/pdf';

/** The kinds of inline media Claude accepts, on a user turn only. */
export type InlineMediaKind = 'image' | 'pdf';

/** An Anthropic tool_use id must match this, or the API rejects the request. */
const VALID_TOOL_USE_ID = /^[a-zA-Z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps a genai content role onto the two roles Anthropic accepts. */
export function toClaudeRole(role?: string): 'user' | 'assistant' {
  return role === 'model' || role === 'assistant' ? 'assistant' : 'user';
}

/**
 * Classifies the inline media a part carries, if any.
 *
 * @param part The part to classify.
 * @return `'image'`, `'pdf'`, or `undefined` when the part carries neither.
 */
export function inlineMediaKind(part: Part): InlineMediaKind | undefined {
  const mimeType = part.inlineData?.mimeType;
  if (mimeType === undefined) {
    return undefined;
  }
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  return baseMimeType(mimeType) === PDF_MIME_TYPE ? 'pdf' : undefined;
}

/**
 * Maps tool call ids Anthropic would reject onto deterministic fallbacks.
 *
 * Use one instance per request so that a `tool_use` block and the
 * `tool_result` block answering it derive the same id from the same invalid
 * source id.
 */
export class ToolUseIdSanitizer {
  private readonly mapping = new Map<string, string>();

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

/** Serialises one tool result value the way Anthropic expects, as text. */
function stringifyToolResult(value: unknown): string {
  return isRecord(value) || Array.isArray(value)
    ? JSON.stringify(value)
    : String(value);
}

function toolResultText(item: unknown): string {
  if (isRecord(item) && item['type'] === 'text' && 'text' in item) {
    return String(item['text']);
  }
  return stringifyToolResult(item);
}

/**
 * Flattens a genai `FunctionResponse.response` into the text Anthropic accepts
 * as `tool_result` content.
 */
function toolResultContent(response?: Record<string, unknown>): string {
  if (!response) {
    return '';
  }
  const content = response['content'];
  if (Array.isArray(content) && content.length > 0) {
    return content.map(toolResultText).join('\n');
  }
  if (typeof content === 'string' && content.length > 0) {
    return content;
  }
  const result = response['result'];
  if (result !== undefined && result !== null) {
    return stringifyToolResult(result);
  }
  if (Object.keys(response).length > 0) {
    return JSON.stringify(response);
  }
  return '';
}

/**
 * Converts base64 media to the block Claude carries it in.
 *
 * `Blob.data` is already a base64 string in genai, so it is passed through
 * unchanged; encoding it again would produce media Claude cannot read.
 *
 * @return The block, or `undefined` when Claude accepts no block for the
 *   media type. The caller decides whether that is an error.
 */
function toMediaBlock(
  mimeType: string,
  data: string,
): ImageBlockParam | DocumentBlockParam | undefined {
  const baseType = baseMimeType(mimeType);
  if (baseType === PDF_MIME_TYPE) {
    return {
      type: 'document',
      source: {type: 'base64', media_type: PDF_MIME_TYPE, data},
    };
  }
  const mediaType = ANTHROPIC_IMAGE_MEDIA_TYPES.find((it) => it === baseType);
  return mediaType === undefined
    ? undefined
    : {type: 'image', source: {type: 'base64', media_type: mediaType, data}};
}

/**
 * Converts the inline media of a conversation part.
 *
 * @return The block, or `undefined` when the part carries no inline media, so
 *   that the caller can go on to the other part shapes.
 * @throws If the part carries an image Claude cannot read. Dropping media the
 *   user put in the conversation would change what the model is answering.
 */
function partToMediaBlock(
  part: Part,
): ImageBlockParam | DocumentBlockParam | undefined {
  const mimeType = part.inlineData?.mimeType;
  const data = part.inlineData?.data;
  if (mimeType === undefined || data === undefined) {
    return undefined;
  }
  const block = toMediaBlock(mimeType, data);
  if (block === undefined && inlineMediaKind(part) === 'image') {
    throw new Error(
      `Claude does not accept the image media type "${mimeType}". ` +
        `Supported types are ${ANTHROPIC_IMAGE_MEDIA_TYPES.join(', ')}.`,
    );
  }
  return block;
}

/**
 * Converts the media a tool attached to its result.
 *
 * Media Claude cannot carry is dropped with a warning rather than throwing:
 * the tool that produced it is usually third-party code the caller cannot
 * change, and losing one attachment beats losing the conversation.
 */
function toolResultMediaBlocks(
  parts?: FunctionResponsePart[],
): Array<ImageBlockParam | DocumentBlockParam> {
  const blocks: Array<ImageBlockParam | DocumentBlockParam> = [];
  for (const part of parts ?? []) {
    const mimeType = part.inlineData?.mimeType;
    const data = part.inlineData?.data;
    if (mimeType === undefined || data === undefined) {
      continue;
    }
    const block = toMediaBlock(mimeType, data);
    if (block === undefined) {
      logger.warn(
        `Claude cannot carry the media type "${mimeType}" in a tool result, ` +
          `so the attachment is dropped.`,
      );
      continue;
    }
    blocks.push(block);
  }
  return blocks;
}

/**
 * Converts a genai function response to an Anthropic `tool_result` block.
 *
 * The result text stays a plain string unless the tool attached media, in
 * which case it becomes the leading text block of a block list.
 */
function toolResultBlock(
  functionResponse: FunctionResponse,
  sanitizer: ToolUseIdSanitizer,
): ToolResultBlockParam {
  const text = toolResultContent(functionResponse.response);
  const media = toolResultMediaBlocks(functionResponse.parts);
  const block: ToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: sanitizer.sanitize(functionResponse.id),
    content: text,
  };
  if (media.length > 0) {
    const blocks: Array<TextBlockParam | ImageBlockParam | DocumentBlockParam> =
      text ? [{type: 'text', text}] : [];
    blocks.push(...media);
    block.content = blocks;
  }
  return block;
}

/**
 * Converts a genai `Part` to the matching Anthropic request block.
 *
 * @param part The part to convert.
 * @param sanitizer The per-request tool call id sanitizer.
 * @throws If the part carries content Claude has no representation for.
 */
export function partToMessageBlock(
  part: Part,
  sanitizer: ToolUseIdSanitizer,
): AnthropicMessageBlock {
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
    const {id, name, args} = part.functionCall;
    if (!name) {
      throw new Error('A function call sent to Claude must have a name.');
    }
    return {
      type: 'tool_use',
      id: sanitizer.sanitize(id),
      name,
      input: args ?? {},
    };
  }
  if (part.functionResponse) {
    return toolResultBlock(part.functionResponse, sanitizer);
  }
  const media = partToMediaBlock(part);
  if (media) {
    return media;
  }
  if (part.executableCode) {
    return {
      type: 'text',
      text: 'Code:```python\n' + part.executableCode.code + '\n```',
    };
  }
  if (part.codeExecutionResult) {
    return {
      type: 'text',
      text:
        'Execution Result:```code_output\n' +
        part.codeExecutionResult.output +
        '\n```',
    };
  }
  throw new Error(`Claude does not support this part: ${JSON.stringify(part)}`);
}

/**
 * Converts a genai `Content` to an Anthropic message.
 *
 * Claude rejects image and PDF blocks on an assistant turn, so those parts are
 * dropped with a warning instead of failing the request.
 *
 * @param content The content to convert.
 * @param sanitizer The per-request tool call id sanitizer.
 */
export function contentToMessageParam(
  content: Content,
  sanitizer: ToolUseIdSanitizer,
): MessageParam {
  const blocks: AnthropicMessageBlock[] = [];
  for (const part of content.parts ?? []) {
    const kind =
      toClaudeRole(content.role) === 'user' ? undefined : inlineMediaKind(part);
    if (kind !== undefined) {
      logger.warn(
        `${kind === 'pdf' ? 'PDF' : 'Image'} data is not supported in Claude ` +
          `for assistant turns.`,
      );
      continue;
    }
    blocks.push(partToMessageBlock(part, sanitizer));
  }
  return {role: toClaudeRole(content.role), content: blocks};
}

/**
 * Converts an Anthropic response block to a genai `Part`.
 *
 * @param block The response block to convert.
 * @throws If the block type has no genai representation.
 */
export function contentBlockToPart(block: ContentBlock): Part {
  switch (block.type) {
    case 'thinking': {
      const part: Part = {text: block.thinking, thought: true};
      if (block.signature) {
        part.thoughtSignature = block.signature;
      }
      return part;
    }
    case 'redacted_thinking':
      // The encrypted blob has to round-trip back to Claude on the next turn
      // to keep the model's reasoning chain intact.
      return {thought: true, thoughtSignature: block.data};
    case 'text':
      return {text: block.text};
    case 'tool_use': {
      if (!isRecord(block.input)) {
        throw new Error(
          `Claude returned a tool_use block for "${block.name}" whose input ` +
            `is not an object.`,
        );
      }
      return {
        functionCall: {id: block.id, name: block.name, args: block.input},
      };
    }
    default:
      throw new Error(`Unsupported Claude content block type: ${block.type}`);
  }
}

/**
 * Maps an Anthropic stop reason onto the genai finish reason.
 *
 * @param stopReason The stop reason Claude reported, if any.
 * @return The finish reason, or `undefined` when Claude reported none.
 */
export function toGenaiFinishReason(
  stopReason?: StopReason | null,
): FinishReason | undefined {
  return stopReason ? GENAI_FINISH_REASONS[stopReason] : undefined;
}

/**
 * Maps Anthropic's token counters onto genai usage metadata.
 *
 * Anthropic reports cached input tokens in fields disjoint from
 * `input_tokens`, while genai expects one prompt count with the cached portion
 * folded in, so the three are summed. It counts thinking tokens inside
 * `output_tokens`, while genai keeps thought and candidate counts disjoint, so
 * the thinking tokens are subtracted back out.
 *
 * @param usage The counters the message reported.
 */
export function toUsageMetadata(
  usage: Usage,
): GenerateContentResponseUsageMetadata {
  const promptTokenCount =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  const outputTokens = usage.output_tokens;
  const thinkingTokens = usage.output_tokens_details?.thinking_tokens;
  // Clamped so a re-tokenized thinking count above output_tokens cannot drive
  // the candidate count negative.
  const thoughtsTokenCount =
    thinkingTokens === undefined
      ? undefined
      : Math.min(thinkingTokens, outputTokens);

  const metadata: GenerateContentResponseUsageMetadata = {
    promptTokenCount,
    candidatesTokenCount: outputTokens - (thoughtsTokenCount ?? 0),
    totalTokenCount: promptTokenCount + outputTokens,
  };
  if (usage.cache_read_input_tokens != null) {
    metadata.cachedContentTokenCount = usage.cache_read_input_tokens;
  }
  if (thoughtsTokenCount !== undefined) {
    metadata.thoughtsTokenCount = thoughtsTokenCount;
  }
  return metadata;
}

/** Converts a complete Anthropic message to an ADK response. */
export function messageToLlmResponse(message: Message): LlmResponse {
  logger.debug('Received response from Claude.');
  const response: LlmResponse = {
    content: {role: 'model', parts: message.content.map(contentBlockToPart)},
    usageMetadata: toUsageMetadata(message.usage),
  };
  const finishReason = toGenaiFinishReason(message.stop_reason);
  if (finishReason !== undefined) {
    response.finishReason = finishReason;
  }
  return response;
}

function toInputSchema(value: unknown, toolName: string): Tool.InputSchema {
  if (!isRecord(value) || value['type'] !== 'object') {
    throw new Error(
      `The JSON Schema for tool "${toolName}" must describe an object.`,
    );
  }
  return {...value, type: 'object'};
}

/** Converts a genai function declaration to an Anthropic tool. */
export function functionDeclarationToToolParam(
  declaration: FunctionDeclaration,
): Tool {
  const name = declaration.name;
  if (!name) {
    throw new Error('A function declaration sent to Claude must have a name.');
  }

  // `parametersJsonSchema` is standard JSON Schema by definition, so it passes
  // through; `parameters` is the genai/OpenAPI dialect, which spells types in
  // upper case and stringifies bounds, so the shared converter translates it.
  let schema: unknown;
  if (declaration.parametersJsonSchema) {
    schema = declaration.parametersJsonSchema;
  } else if (declaration.parameters) {
    schema = genaiSchemaToJsonSchema(declaration.parameters);
  } else {
    schema = {type: 'object', properties: {}};
  }

  return {
    name,
    description: declaration.description ?? '',
    input_schema: toInputSchema(schema, name),
  };
}

/**
 * Maps a genai `ThinkingConfig` onto Anthropic's thinking parameter.
 *
 * A budget of `0` disables thinking, a negative budget (genai `AUTOMATIC` is
 * `-1`) selects adaptive thinking, and a positive budget selects manual
 * budgeting. Anthropic owns the lower bound on a manual budget, so it is not
 * checked here.
 *
 * @param config The generate-content config, if any.
 * @return The thinking parameter, or `undefined` to leave it unset.
 * @throws If a thinking config is present but states no budget.
 */
export function buildThinkingParam(
  config?: GenerateContentConfig,
): ThinkingConfigParam | undefined {
  const thinkingBudget = config?.thinkingConfig?.thinkingBudget;
  if (!config?.thinkingConfig) {
    return undefined;
  }
  if (thinkingBudget === undefined || thinkingBudget === null) {
    throw new Error(
      'thinking_budget must be set explicitly when ThinkingConfig is ' +
        'provided for Anthropic models. Use 0 to disable thinking, -1 for ' +
        'adaptive (model-chosen depth), or a positive integer (>= 1024) for ' +
        'manual budgeting.',
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
 * Reads Anthropic's reasoning effort from the config.
 *
 * genai's own `thinkingConfig.thinkingLevel` has no Anthropic equivalent, so
 * it is ignored with a warning, and combining the two is an error rather than
 * a silent choice between them.
 *
 * @param config The generate-content config, if any.
 * @return The effort level, or `undefined` to leave `output_config` unset.
 * @throws If both `effort` and `thinkingConfig.thinkingLevel` are set.
 */
export function buildEffortParam(
  config?: AnthropicGenerateContentConfig,
): AnthropicEffort | undefined {
  const effort = config?.effort ?? undefined;
  const thinkingLevel = config?.thinkingConfig?.thinkingLevel;
  if (effort !== undefined) {
    if (thinkingLevel) {
      throw new Error(
        'thinking_level is not supported in AnthropicGenerateContentConfig. ' +
          'Use the `effort` field directly to configure reasoning effort.',
      );
    }
    return effort;
  }
  if (thinkingLevel) {
    logger.warn(
      'Standard thinking_config.thinking_level is not supported for ' +
        'Anthropic models and will be ignored. Use ' +
        'AnthropicGenerateContentConfig and set the `effort` field directly ' +
        'to configure reasoning effort.',
    );
  }
  return undefined;
}

/**
 * Flattens a genai system instruction into the plain text Anthropic accepts.
 *
 * @param instruction The system instruction, if any.
 * @return The instruction text, empty when there is nothing to say. The
 *   caller omits Anthropic's `system` field for an empty string.
 */
export function systemInstructionToText(instruction?: ContentUnion): string {
  if (instruction === undefined) {
    return '';
  }
  if (typeof instruction === 'string') {
    return instruction;
  }
  if (Array.isArray(instruction)) {
    return instruction.map(systemInstructionToText).join('\n');
  }
  if ('parts' in instruction) {
    return (instruction.parts ?? []).map(systemInstructionToText).join('\n');
  }
  return 'text' in instruction ? (instruction.text ?? '') : '';
}
