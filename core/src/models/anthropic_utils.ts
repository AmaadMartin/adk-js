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
  RedactedThinkingBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  ThinkingConfigParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  Content,
  ContentUnion,
  FunctionDeclaration,
  GenerateContentConfig,
  Part,
} from '@google/genai';

import {logger} from '../utils/logger.js';

import {LlmResponse} from './llm_response.js';

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

/** How each media kind is named in the warning Claude users see. */
const MEDIA_KIND_LABELS: Record<InlineMediaKind, string> = {
  image: 'Image',
  pdf: 'PDF',
};

/** An Anthropic tool_use id must match this, or the API rejects the request. */
const VALID_TOOL_USE_ID = /^[a-zA-Z0-9_-]+$/;

/** JSON Schema keys whose value is itself a map of schemas. */
const SCHEMA_MAP_KEYS = [
  '$defs',
  'dependentSchemas',
  'patternProperties',
  'properties',
];

/** JSON Schema keys whose value is a schema, or a list of schemas. */
const SCHEMA_CHILD_KEYS = [
  'additionalProperties',
  'allOf',
  'anyOf',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'oneOf',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedProperties',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strips the parameters from a MIME type, e.g. `text/csv; charset=utf-8`. */
function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim();
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
  if (mimeType.startsWith('image')) {
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

function toImageMediaType(mimeType: string): AnthropicImageMediaType {
  const baseType = baseMimeType(mimeType);
  const supported = ANTHROPIC_IMAGE_MEDIA_TYPES.find((it) => it === baseType);
  if (supported === undefined) {
    throw new Error(
      `Claude does not accept the image media type "${mimeType}". ` +
        `Supported types are ${ANTHROPIC_IMAGE_MEDIA_TYPES.join(', ')}.`,
    );
  }
  return supported;
}

/**
 * Converts an inline-data part to an image or document block.
 *
 * `Blob.data` is already a base64 string in genai, so it is passed through
 * unchanged; encoding it again would produce media Claude cannot read.
 */
function toMediaBlock(
  part: Part,
): ImageBlockParam | DocumentBlockParam | undefined {
  const kind = inlineMediaKind(part);
  const mimeType = part.inlineData?.mimeType;
  const data = part.inlineData?.data;
  if (kind === undefined || mimeType === undefined || data === undefined) {
    return undefined;
  }
  if (kind === 'image') {
    return {
      type: 'image',
      source: {type: 'base64', media_type: toImageMediaType(mimeType), data},
    };
  }
  return {
    type: 'document',
    source: {type: 'base64', media_type: PDF_MIME_TYPE, data},
  };
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
    return {
      type: 'tool_result',
      tool_use_id: sanitizer.sanitize(part.functionResponse.id),
      content: toolResultContent(part.functionResponse.response),
      is_error: false,
    };
  }
  const media = toMediaBlock(part);
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
    const kind = content.role === 'user' ? undefined : inlineMediaKind(part);
    if (kind !== undefined) {
      logger.warn(
        `${MEDIA_KIND_LABELS[kind]} data is not supported in Claude for ` +
          `assistant turns.`,
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
 * Parses the JSON arguments Claude streams for one `tool_use` block.
 *
 * @param argsJson The accumulated `input_json_delta` text, possibly empty.
 * @throws If the arguments parse to something other than an object.
 */
export function parseToolUseArgs(argsJson: string): Record<string, unknown> {
  if (!argsJson) {
    return {};
  }
  const parsed: unknown = JSON.parse(argsJson);
  if (!isRecord(parsed)) {
    throw new Error(
      `Claude streamed tool arguments that are not an object: ${argsJson}`,
    );
  }
  return parsed;
}

/** Converts a complete Anthropic message to an ADK response. */
export function messageToLlmResponse(message: Message): LlmResponse {
  logger.debug('Received response from Claude.');
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;
  return {
    content: {role: 'model', parts: message.content.map(contentBlockToPart)},
    usageMetadata: {
      promptTokenCount: inputTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: inputTokens + outputTokens,
    },
  };
}

/**
 * Lowercases every string `type` in a JSON Schema, in place.
 *
 * genai spells schema types in upper case (`OBJECT`, `STRING`); Anthropic
 * accepts only the lower-case JSON Schema spelling.
 */
function lowercaseSchemaTypes(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      lowercaseSchemaTypes(item);
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
      for (const grandChild of Object.values(child)) {
        lowercaseSchemaTypes(grandChild);
      }
    }
  }
  for (const key of SCHEMA_CHILD_KEYS) {
    lowercaseSchemaTypes(value[key]);
  }
}

/** Deep-copies a value to plain JSON, dropping `undefined` properties. */
function toPlainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
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

  let inputSchema: Tool.InputSchema;
  if (declaration.parametersJsonSchema) {
    const schema = toPlainJson(declaration.parametersJsonSchema);
    lowercaseSchemaTypes(schema);
    inputSchema = toInputSchema(schema, name);
  } else {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      declaration.parameters?.properties ?? {},
    )) {
      properties[key] = toPlainJson(value);
    }
    inputSchema = {type: 'object', properties};
    const required = declaration.parameters?.required;
    if (required && required.length > 0) {
      inputSchema.required = [...required];
    }
    lowercaseSchemaTypes(inputSchema);
  }

  return {
    name,
    description: declaration.description ?? '',
    input_schema: inputSchema,
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
 * Flattens a genai system instruction into the plain text Anthropic accepts.
 *
 * @param instruction The system instruction, if any.
 * @return The instruction text, or `undefined` to leave `system` unset.
 */
export function systemInstructionToText(
  instruction?: ContentUnion,
): string | undefined {
  return instruction === undefined
    ? undefined
    : flattenContentUnion(instruction);
}

function flattenContentUnion(instruction: ContentUnion): string {
  if (typeof instruction === 'string') {
    return instruction;
  }
  if (Array.isArray(instruction)) {
    return instruction.map(flattenContentUnion).join('\n');
  }
  if ('parts' in instruction) {
    return (instruction.parts ?? []).map(flattenContentUnion).join('\n');
  }
  return 'text' in instruction ? (instruction.text ?? '') : '';
}
