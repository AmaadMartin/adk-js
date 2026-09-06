/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  Part,
} from '@google/genai';

import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {parsePythonLiteral} from '../utils/python_literal_utils.js';

import {
  finishReasonToErrorMessage,
  mapFinishReason,
} from './lite_llm_model_utils.js';
import {isJsonObject} from './lite_llm_request_converters.js';
import {
  ChatMessage,
  JsonObject,
  JsonValue,
  MessageContent,
  ModelResponse,
  ModelResponseStream,
  ToolCall,
  Usage,
} from './lite_llm_types.js';
import {LlmResponse} from './llm_response.js';

/** Keys a provider may nest reasoning text under. */
const REASONING_TEXT_KEYS = [
  'text',
  'content',
  'reasoning',
  'reasoning_content',
];

/** Matches an unquoted JSON object key. */
const UNQUOTED_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Usage metadata plus the cache-write count LiteLLM reports for Anthropic and
 * Bedrock, which `GenerateContentResponseUsageMetadata` does not declare.
 */
export interface LiteLlmUsageMetadata extends GenerateContentResponseUsageMetadata {
  cacheCreationInputTokens?: number;
}

/** A run of streamed text. */
export interface TextChunk {
  kind: 'text';
  text: string;
}

/** A tool call, or one streamed fragment of one. */
export interface FunctionChunk {
  kind: 'function';
  id?: string;
  name?: string;
  args?: string;
  index: number;
}

/** Reasoning the model emitted, already converted to thought parts. */
export interface ReasoningChunk {
  kind: 'reasoning';
  parts: Part[];
}

/** Token accounting, which providers send in a chunk of its own. */
export interface UsageChunk {
  kind: 'usage';
  usage: LiteLlmUsageMetadata;
}

/** One unit of meaning read out of a response or a stream chunk. */
export type ResponseChunk =
  | TextChunk
  | FunctionChunk
  | ReasoningChunk
  | UsageChunk;

/** What {@link parseToolCallsFromText} found in a text response. */
export interface ParsedToolCallText {
  toolCalls: ToolCall[];
  /** The prose left over once the tool calls were removed. */
  remainder?: string;
}

/** What {@link splitMessageContentAndToolCalls} read out of a message. */
export interface MessageContentAndToolCalls {
  content?: MessageContent | null;
  toolCalls: ToolCall[];
}

/** Options for {@link messageToGenerateContentResponse}. */
export interface MessageResponseOptions {
  isPartial?: boolean;
  modelVersion?: string;
  thoughtParts?: Part[];
}

/**
 * Reports when a top-level JSON object closes in a stream of fragments.
 *
 * Only braces are counted. Tool-call arguments are always top-level objects,
 * so bracket depth cannot end one, and characters inside a nested array still
 * balance correctly.
 */
export class BraceDepthTracker {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private seenOpen = false;

  /** Feeds new characters and returns true when an object just closed. */
  feed(fragment: string): boolean {
    let closed = false;
    for (const char of fragment) {
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (char === '\\') {
          this.escaped = true;
        } else if (char === '"') {
          this.inString = false;
        }
        continue;
      }
      if (char === '"') {
        this.inString = true;
      } else if (char === '{') {
        this.depth++;
        this.seenOpen = true;
      } else if (char === '}' && this.depth > 0) {
        this.depth--;
        if (this.depth === 0 && this.seenOpen) {
          closed = true;
          this.seenOpen = false;
        }
      }
    }
    return closed;
  }
}

/**
 * Quotes simple unquoted object keys, leaving string contents untouched.
 *
 * Some providers finalize a streamed tool call as a JavaScript-style object
 * literal rather than strict JSON. This repairs that one shape.
 */
export function quoteUnquotedJsonObjectKeys(value: string): string {
  const result: string[] = [];
  let i = 0;
  let inString = false;
  let stringQuote = '';
  let escaped = false;

  while (i < value.length) {
    const char = value[i];
    if (inString) {
      result.push(char);
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      i++;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      result.push(char);
      i++;
      continue;
    }

    if (char === '{' || char === ',') {
      result.push(char);
      i++;
      const whitespaceStart = i;
      while (i < value.length && /\s/.test(value[i])) {
        i++;
      }
      result.push(value.slice(whitespaceStart, i));

      const keyMatch = UNQUOTED_KEY_RE.exec(value.slice(i));
      if (keyMatch) {
        const keyEnd = i + keyMatch[0].length;
        let colonIndex = keyEnd;
        while (colonIndex < value.length && /\s/.test(value[colonIndex])) {
          colonIndex++;
        }
        if (value[colonIndex] === ':') {
          result.push(`"${keyMatch[0]}"`);
          result.push(value.slice(keyEnd, colonIndex));
          i = colonIndex;
          continue;
        }
      }
      continue;
    }

    result.push(char);
    i++;
  }

  return result.join('');
}

/**
 * Parses the arguments of a tool call.
 *
 * Strict JSON is the primary path. When that fails, the payload is read as a
 * Python literal, because some providers finalize a streamed tool call whose
 * argument payload is a Python dict literal. Unquoted object keys are repaired
 * last, and the repaired text goes through both parsers again. When every
 * attempt fails the original parse error is thrown, because it describes the
 * payload the provider actually sent.
 *
 * @throws SyntaxError When the arguments are not parseable.
 */
export function parseToolCallArguments(args?: string): Record<string, unknown> {
  if (!args) {
    return {};
  }
  let parseError: unknown;
  try {
    return asArgsRecord(JSON.parse(args));
  } catch (error: unknown) {
    parseError = error;
  }

  const literal = parsePythonLiteral(args);
  if (literal !== undefined) {
    return asArgsRecord(literal);
  }

  const repaired = quoteUnquotedJsonObjectKeys(args);
  if (repaired !== args) {
    try {
      return asArgsRecord(JSON.parse(repaired));
    } catch {
      const repairedLiteral = parsePythonLiteral(repaired);
      if (repairedLiteral !== undefined) {
        return asArgsRecord(repairedLiteral);
      }
    }
  }
  throw parseError;
}

/** Coerces a parsed JSON value into the argument object a call needs. */
function asArgsRecord(value: unknown): Record<string, unknown> {
  return isJsonObject(value) ? value : {};
}

/** Returns the index just past the JSON object starting at `start`. */
function findJsonObjectEnd(text: string, start: number): number | undefined {
  const tracker = new BraceDepthTracker();
  for (let i = start; i < text.length; i++) {
    if (tracker.feed(text[i])) {
      return i + 1;
    }
  }
  return undefined;
}

/** Builds a tool call from a `{name, arguments}` object embedded in text. */
export function buildToolCallFromJsonDict(
  candidate: unknown,
  index: number,
): ToolCall | undefined {
  if (!isJsonObject(candidate)) {
    return undefined;
  }
  const name = candidate['name'];
  const args = candidate['arguments'];
  if (typeof name !== 'string' || args === undefined || args === null) {
    return undefined;
  }

  const callId = candidate['id'];
  const callIndex = candidate['index'];
  return {
    type: 'function',
    id: callId ? String(callId) : `adk_tool_call_${randomUUID()}`,
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
    index: typeof callIndex === 'number' ? callIndex : index,
  };
}

/**
 * Extracts tool calls a provider emitted as inline JSON inside a text
 * response, and returns the prose that was left around them.
 */
export function parseToolCallsFromText(text: string): ParsedToolCallText {
  const toolCalls: ToolCall[] = [];
  if (!text) {
    return {toolCalls};
  }

  const remainderSegments: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const braceIndex = text.indexOf('{', cursor);
    if (braceIndex === -1) {
      remainderSegments.push(text.slice(cursor));
      break;
    }
    remainderSegments.push(text.slice(cursor, braceIndex));

    const end = findJsonObjectEnd(text, braceIndex);
    let candidate: unknown;
    let parsed = false;
    if (end !== undefined) {
      try {
        candidate = JSON.parse(text.slice(braceIndex, end));
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    if (!parsed || end === undefined) {
      remainderSegments.push(text[braceIndex]);
      cursor = braceIndex + 1;
      continue;
    }

    const toolCall = buildToolCallFromJsonDict(candidate, toolCalls.length);
    if (toolCall) {
      toolCalls.push(toolCall);
    } else {
      remainderSegments.push(text.slice(braceIndex, end));
    }
    cursor = end;
  }

  const remainder = remainderSegments.join('').trim();
  return {toolCalls, remainder: remainder || undefined};
}

/**
 * Returns the message content and its tool calls.
 *
 * Structured `tool_calls` win: a response carries those or inline JSON, never
 * both, so the text parser only runs when there are none.
 */
export function splitMessageContentAndToolCalls(
  message: ChatMessage,
): MessageContentAndToolCalls {
  const toolCalls = message.tool_calls ? [...message.tool_calls] : [];
  const content = message.content;
  if (toolCalls.length > 0 || typeof content !== 'string') {
    return {content, toolCalls};
  }

  const parsed = parseToolCallsFromText(content);
  if (parsed.toolCalls.length > 0) {
    return {content: parsed.remainder, toolCalls: parsed.toolCalls};
  }
  return {content, toolCalls: []};
}

/**
 * Reads the reasoning payload off a message.
 *
 * `thinking_blocks` wins because Anthropic carries per-block structure there;
 * `reasoning_content` is the LiteLLM standard field and `reasoning` is what LM
 * Studio and vLLM send.
 */
export function extractReasoningValue(message?: ChatMessage): unknown {
  if (!message) {
    return undefined;
  }
  if (
    message.thinking_blocks !== undefined &&
    message.thinking_blocks !== null
  ) {
    return message.thinking_blocks;
  }
  if (
    message.reasoning_content !== undefined &&
    message.reasoning_content !== null
  ) {
    return message.reasoning_content;
  }
  return message.reasoning;
}

/** Collects the text fragments out of a provider's reasoning payload. */
export function iterReasoningTexts(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(iterReasoningTexts);
  }
  if (isJsonObject(value)) {
    const texts: string[] = [];
    for (const key of REASONING_TEXT_KEYS) {
      const text = value[key];
      if (typeof text === 'string') {
        texts.push(text);
      }
    }
    return texts;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  return [];
}

/** Converts a provider's reasoning payload into genai thought parts. */
export function convertReasoningValueToParts(value: unknown): Part[] {
  if (!Array.isArray(value)) {
    return iterReasoningTexts(value)
      .filter(Boolean)
      .map((text) => ({text, thought: true}));
  }

  const parts: Part[] = [];
  for (const block of value) {
    if (isJsonObject(block)) {
      const blockType = block['type'];
      if (blockType === 'redacted') {
        continue;
      }
      if (blockType === 'thinking') {
        const thinking = block['thinking'];
        if (typeof thinking === 'string' && thinking) {
          parts.push({text: thinking, thought: true});
        }
        continue;
      }
    }
    for (const text of iterReasoningTexts(block)) {
      if (text) {
        parts.push({text, thought: true});
      }
    }
  }
  return parts;
}

/** Reads the cached prompt tokens, whichever shape the provider used. */
function extractCachedPromptTokens(usage: Usage): number {
  const details = usage.prompt_tokens_details;
  if (Array.isArray(details)) {
    const total = details.reduce(
      (sum, item) =>
        sum +
        (typeof item?.cached_tokens === 'number' ? item.cached_tokens : 0),
      0,
    );
    if (total > 0) {
      return total;
    }
  } else if (typeof details?.cached_tokens === 'number') {
    return details.cached_tokens;
  }

  for (const value of [
    usage.cached_prompt_tokens,
    usage.cached_tokens,
    usage.cache_read_input_tokens,
  ]) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return 0;
}

/** Reads the cache-write tokens, which only some providers report. */
function extractCacheCreationTokens(usage: Usage): number | undefined {
  for (const value of [
    usage.cache_creation_input_tokens,
    usage.cache_write_input_tokens,
  ]) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

/** Converts provider token accounting into genai usage metadata. */
export function extractUsageMetadata(usage: Usage): LiteLlmUsageMetadata {
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  const metadata: LiteLlmUsageMetadata = {
    promptTokenCount: usage.prompt_tokens ?? 0,
    candidatesTokenCount: usage.completion_tokens ?? 0,
    totalTokenCount: usage.total_tokens ?? 0,
    cachedContentTokenCount: extractCachedPromptTokens(usage),
    thoughtsTokenCount: reasoningTokens || undefined,
  };
  const cacheCreationTokens = extractCacheCreationTokens(usage);
  if (cacheCreationTokens !== undefined) {
    metadata.cacheCreationInputTokens = cacheCreationTokens;
  }
  return metadata;
}

/** Returns true when every member of `value` is a string. */
function isStringArray(value: JsonValue): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/** Returns true when every member of `value` is a plain object. */
function isObjectArray(value: JsonValue): boolean {
  return Array.isArray(value) && value.every(isJsonObject);
}

/**
 * The shape each field of {@link GroundingMetadata} must have. A provider is
 * free to send fields the SDK does not declare, so an unlisted field passes.
 */
const GROUNDING_METADATA_FIELDS: Record<string, (value: JsonValue) => boolean> =
  {
    imageSearchQueries: isStringArray,
    webSearchQueries: isStringArray,
    retrievalQueries: isStringArray,
    googleMapsWidgetContextToken: (value) => typeof value === 'string',
    groundingChunks: isObjectArray,
    groundingSupports: isObjectArray,
    sourceFlaggingUris: isObjectArray,
    retrievalMetadata: isJsonObject,
    searchEntryPoint: isJsonObject,
  };

/** Reports whether a payload matches every field the SDK type declares. */
function isGroundingMetadata(
  value: JsonObject,
): value is JsonObject & GroundingMetadata {
  return Object.entries(GROUNDING_METADATA_FIELDS).every(([field, isValid]) => {
    const fieldValue = value[field];
    return fieldValue === undefined || isValid(fieldValue);
  });
}

/**
 * Pulls Gemini grounding metadata off a response or stream chunk.
 *
 * LiteLLM puts it on the response rather than inside the message, so the
 * native Gemini path would miss it.
 */
export function extractGroundingMetadata(
  response: ModelResponse | ModelResponseStream,
): GroundingMetadata | undefined {
  let raw = response.vertex_ai_grounding_metadata;
  if (!raw) {
    return undefined;
  }
  if (Array.isArray(raw)) {
    raw = raw.length > 0 ? raw[0] : undefined;
  }
  if (isJsonObject(raw) && isGroundingMetadata(raw)) {
    return raw;
  }
  logger.warn(
    'LiteLlm: vertex_ai_grounding_metadata did not match the' +
      ' GroundingMetadata schema and was dropped.',
  );
  return undefined;
}

/** Converts a chat message into the `LlmResponse` it represents. */
export function messageToGenerateContentResponse(
  message: ChatMessage,
  options: MessageResponseOptions = {},
): LlmResponse {
  const thoughtParts = options.thoughtParts?.length
    ? options.thoughtParts
    : convertReasoningValueToParts(extractReasoningValue(message));
  const parts: Part[] = [...thoughtParts];

  const {content, toolCalls} = splitMessageContentAndToolCalls(message);
  if (typeof content === 'string' && content) {
    parts.push({text: content});
  }
  for (const toolCall of toolCalls) {
    if (toolCall.type !== 'function') {
      continue;
    }
    parts.push({
      functionCall: {
        id: toolCall.id,
        name: toolCall.function?.name,
        args: parseToolCallArguments(toolCall.function?.arguments),
      },
    });
  }

  return {
    content: {role: 'model', parts},
    partial: options.isPartial ?? false,
    modelVersion: options.modelVersion,
  };
}

/** Stamps a finish reason, and the error it implies, onto a response. */
export function applyFinishReason(
  llmResponse: LlmResponse,
  finishReason: string | null | undefined,
): void {
  const mapped = mapFinishReason(finishReason);
  if (!mapped) {
    return;
  }
  llmResponse.finishReason = mapped;
  if (mapped !== 'STOP') {
    llmResponse.errorCode = mapped;
    llmResponse.errorMessage = finishReasonToErrorMessage(mapped);
  }
}

/** Converts a non-streaming response into an `LlmResponse`. */
export function modelResponseToGenerateContentResponse(
  response: ModelResponse,
): LlmResponse {
  const choice = response.choices?.[0];
  const message = choice?.message;

  // A response with no message is not an error: some providers answer a
  // filtered or empty generation that way.
  const llmResponse: LlmResponse = hasMeaningfulSignal(message)
    ? messageToGenerateContentResponse(message, {modelVersion: response.model})
    : {content: {role: 'model', parts: []}, modelVersion: response.model};

  applyFinishReason(llmResponse, choice?.finish_reason);
  if (response.usage) {
    llmResponse.usageMetadata = extractUsageMetadata(response.usage);
  }
  const groundingMetadata = extractGroundingMetadata(response);
  if (groundingMetadata) {
    llmResponse.groundingMetadata = groundingMetadata;
  }
  return llmResponse;
}

/** Returns true when the message carries anything worth converting. */
function hasMeaningfulSignal(message?: ChatMessage): message is ChatMessage {
  if (!message) {
    return false;
  }
  return Boolean(
    message.content ||
    message.tool_calls?.length ||
    message.reasoning_content ||
    message.reasoning ||
    message.thinking_blocks,
  );
}

/** Reads the message a choice carries: `delta` when streamed, else `message`. */
function choiceMessage(choice: {
  message?: ChatMessage;
  delta?: ChatMessage;
}): ChatMessage | undefined {
  return choice.delta ?? choice.message;
}

/**
 * Splits a response or stream chunk into the units of meaning it carries,
 * each paired with the finish reason of the choice it came from.
 */
export function* modelResponseToChunks(
  response: ModelResponse | ModelResponseStream,
): Generator<[ResponseChunk | undefined, string | undefined]> {
  const choice = response.choices?.[0];
  if (!choice) {
    yield [undefined, undefined];
  } else {
    const finishReason = choice.finish_reason ?? undefined;
    const rawMessage = choiceMessage(choice);
    const message = hasMeaningfulSignal(rawMessage) ? rawMessage : undefined;

    let content: MessageContent | null | undefined;
    let toolCalls: ToolCall[] = [];
    let reasoningParts: Part[] = [];
    if (message) {
      ({content, toolCalls} = splitMessageContentAndToolCalls(message));
      reasoningParts = convertReasoningValueToParts(
        extractReasoningValue(message),
      );
    }

    if (reasoningParts.length > 0) {
      yield [{kind: 'reasoning', parts: reasoningParts}, finishReason];
    }
    if (typeof content === 'string' && content) {
      yield [{kind: 'text', text: content}, finishReason];
    }
    for (const [idx, toolCall] of toolCalls.entries()) {
      if (toolCall.type !== 'function' || !toolCall.function) {
        continue;
      }
      const {name, arguments: args} = toolCall.function;
      // A chunk with neither a name nor arguments carries no information.
      if (!name && !args) {
        continue;
      }
      yield [
        {
          kind: 'function',
          id: toolCall.id,
          name,
          args,
          index: toolCall.index ?? idx,
        },
        finishReason,
      ];
    }
    if (
      finishReason &&
      !content &&
      toolCalls.length === 0 &&
      reasoningParts.length === 0
    ) {
      yield [undefined, finishReason];
    }
  }

  // Usage arrives in a chunk of its own, typically after the one carrying the
  // finish reason.
  if (response.usage) {
    yield [
      {kind: 'usage', usage: extractUsageMetadata(response.usage)},
      undefined,
    ];
  }
}
