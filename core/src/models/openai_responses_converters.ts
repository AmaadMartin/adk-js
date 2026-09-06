/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conversions between the genai types ADK speaks and the OpenAI Responses API
 * wire format.
 *
 * Ported from adk-python
 * `src/google/adk/labs/openai/_openai_responses_llm.py`.
 */

import {
  Blob,
  Content,
  ContentUnion,
  FileData,
  FinishReason,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  Part,
  Schema,
  ThinkingLevel,
  Type,
} from '@google/genai';
import type {OpenAI} from 'openai';

import {genaiSchemaToJsonSchema} from '../utils/genai_schema_to_json.js';
import {logger} from '../utils/logger.js';

import {LlmResponse} from './llm_response.js';
import {
  enforceStrictOpenAiSchema,
  JsonSchemaObject,
  lowercaseSchemaTypes,
} from './openai_schema.js';

/** Prefix given to a model refusal so it survives as ordinary text. */
const REFUSAL_PREFIX = 'OpenAI refusal: ';

/** Logged once per media part the Responses API cannot carry. */
const MEDIA_IN_ASSISTANT_TURN =
  'Media data is not supported in Responses assistant turns.';

/** Mime type assumed for inline data that declares none. */
const DEFAULT_INLINE_DATA_MIME_TYPE = 'application/octet-stream';

/** Filename given to an inline-data file part that has no display name. */
const DEFAULT_INLINE_DATA_FILENAME = 'inline_data';

/** Name given to a strict `json_schema` text format with no schema title. */
const DEFAULT_RESPONSE_SCHEMA_NAME = 'schema';

/** A call id the Responses API accepts unchanged. */
const VALID_CALL_ID = /^[a-zA-Z0-9_-]+$/;

/** Prefix of the id minted for a missing or unusable function call id. */
const FALLBACK_CALL_ID_PREFIX = 'call_adk_fallback_';

/** The genai `type` values, used to tell a genai `Schema` from JSON Schema. */
const GENAI_SCHEMA_TYPES = new Set<string>(Object.values(Type));

/**
 * `incomplete_details.reason` values that mean the output hit a length limit.
 *
 * `max_tokens` is not in the SDK's declared union but adk-python accepts it,
 * so it is matched as a plain string.
 */
const MAX_TOKEN_REASONS = new Set<string>(['max_output_tokens', 'max_tokens']);

/** Reasoning summary detail asked for whenever reasoning is enabled. */
const REASONING_SUMMARY = 'concise';

/**
 * Returned by {@link openaiReasoningConfig} when the request said nothing about
 * thinking, which is different from a request that explicitly cleared it.
 */
export const REASONING_NOT_GIVEN = Symbol('reasoningNotGiven');

/** The reasoning efforts a genai thinking level maps onto. */
type MappedReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/** Narrows an arbitrary value to a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows an arbitrary schema value to the genai `Schema` dialect. */
function isGenaiSchema(value: unknown): value is Schema {
  return (
    isRecord(value) &&
    typeof value['type'] === 'string' &&
    GENAI_SCHEMA_TYPES.has(value['type'])
  );
}

/**
 * Maps function call ids onto ids the Responses API accepts.
 *
 * One instance covers one request: the fallback counter restarts per request,
 * and a repeated unusable id maps to the same fallback within that request so
 * a call and its output stay paired.
 */
export class CallIdSanitizer {
  private readonly mapping = new Map<string, string>();
  private nextFallback = 0;

  /**
   * Returns an id the Responses API accepts for `callId`.
   *
   * @param callId The id ADK carries, if any.
   * @return `callId` when it is already acceptable, otherwise a minted one.
   */
  sanitize(callId?: string): string {
    if (callId && VALID_CALL_ID.test(callId)) {
      return callId;
    }
    if (!callId) {
      return this.mint();
    }
    const existing = this.mapping.get(callId);
    if (existing !== undefined) {
      return existing;
    }
    const fallback = this.mint();
    this.mapping.set(callId, fallback);
    return fallback;
  }

  private mint(): string {
    return `${FALLBACK_CALL_ID_PREFIX}${this.nextFallback++}`;
  }
}

/**
 * Serializes a tool result into the string a `function_call_output` carries.
 *
 * MCP-style `{content: [{type: 'text', text}]}` results are flattened to their
 * text, and a `{result}` wrapper is unwrapped, so the model sees the answer
 * rather than the envelope.
 *
 * @param value The tool result.
 * @return The serialized output.
 */
export function serializeToolOutput(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value)) {
    const content = value['content'];
    if (Array.isArray(content) && content.length > 0) {
      return content.map(contentItemToText).join('\n');
    }
    if (typeof content === 'string' && content) {
      return content;
    }
    const result = value['result'];
    if (result !== undefined && result !== null) {
      return typeof result === 'string' ? result : JSON.stringify(result);
    }
  }
  return JSON.stringify(value);
}

/** Renders one entry of an MCP-style `content` list as text. */
function contentItemToText(item: unknown): string {
  if (isRecord(item)) {
    const text = item['text'];
    return item['type'] === 'text' && text !== undefined
      ? String(text)
      : JSON.stringify(item);
  }
  return String(item);
}

/**
 * Parses a JSON object out of a function-call argument string.
 *
 * @param value The argument string, if any.
 * @return The parsed object, or `{}` when the string is absent, malformed, or
 *   not an object. A malformed string is logged, never thrown.
 */
export function loadsJsonObject(value?: string): Record<string, unknown> {
  if (!value) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    logger.warn('Failed to parse Responses API function arguments as JSON.');
    return {};
  }
  return isRecord(parsed) ? parsed : {};
}

/** Returns the text of a part, or a plain string, as a string. */
function partUnionText(part: Part | string): string {
  return typeof part === 'string' ? part : (part.text ?? '');
}

/** Narrows a system instruction that is a single object to a `Content`. */
function isContent(value: Content | Part): value is Content {
  return 'parts' in value;
}

/**
 * Serializes an ADK system instruction into Responses `instructions`.
 *
 * @param instruction The instruction in any of the shapes genai accepts.
 * @return The concatenated text, or `undefined` when there is none.
 */
export function serializeSystemInstruction(
  instruction?: ContentUnion,
): string | undefined {
  if (!instruction) {
    return undefined;
  }
  if (typeof instruction === 'string') {
    return instruction;
  }
  if (Array.isArray(instruction)) {
    return instruction.map(partUnionText).join('');
  }
  if (isContent(instruction)) {
    return (instruction.parts ?? []).map(partUnionText).join('');
  }
  return partUnionText(instruction);
}

/**
 * Renders a response schema as a JSON Schema object.
 *
 * A genai `Schema` and a plain JSON Schema need different treatment:
 * `genaiSchemaToJsonSchema` drops a `type` it does not recognise, so a
 * document that is already JSON Schema is copied and only its `type` keywords
 * are lowercased.
 *
 * @param schema The schema in either dialect.
 * @return The JSON Schema object, or `{}` when there is nothing to convert.
 */
export function schemaToJsonObject(schema: unknown): JsonSchemaObject {
  if (isGenaiSchema(schema)) {
    return genaiSchemaToJsonSchema(schema);
  }
  if (!isRecord(schema)) {
    return {};
  }
  const copy = structuredClone(schema);
  lowercaseSchemaTypes(copy);
  return copy;
}

/** Sanitizes a schema title into the `^[a-zA-Z0-9_-]+$` name OpenAI requires. */
function sanitizeSchemaName(title: unknown): string {
  if (typeof title !== 'string') {
    return DEFAULT_RESPONSE_SCHEMA_NAME;
  }
  // The replacement is a literal `_`, so `$` expansion cannot apply.
  return title.replace(/[^a-zA-Z0-9_-]/g, '_') || DEFAULT_RESPONSE_SCHEMA_NAME;
}

/**
 * Maps ADK structured-output settings onto the Responses `text` config.
 *
 * @param config The request's generation config.
 * @return The text config, or `undefined` when the request asks for none.
 */
export function responseTextConfig(
  config: GenerateContentConfig,
): OpenAI.Responses.ResponseTextConfig | undefined {
  const schema = config.responseSchema ?? config.responseJsonSchema;
  if (schema) {
    const schemaObject = schemaToJsonObject(schema);
    if (Object.keys(schemaObject).length === 0) {
      return undefined;
    }
    const name = sanitizeSchemaName(schemaObject['title']);
    enforceStrictOpenAiSchema(schemaObject);
    return {
      format: {type: 'json_schema', name, strict: true, schema: schemaObject},
    };
  }
  if (config.responseMimeType === 'application/json') {
    return {format: {type: 'json_object'}};
  }
  return undefined;
}

/** Returns the Responses reasoning effort a genai thinking level asks for. */
function effortForThinkingLevel(level: ThinkingLevel): MappedReasoningEffort {
  switch (level) {
    case ThinkingLevel.MINIMAL:
      return 'minimal';
    case ThinkingLevel.LOW:
      return 'low';
    case ThinkingLevel.HIGH:
      return 'high';
    case ThinkingLevel.MEDIUM:
    case ThinkingLevel.THINKING_LEVEL_UNSPECIFIED:
    default:
      return 'medium';
  }
}

/**
 * Maps an ADK thinking config onto the Responses reasoning config.
 *
 * Responses reasoning is effort-based rather than token-budget based, so a
 * zero budget becomes minimal effort and any other budget becomes medium.
 *
 * @param config The request's generation config.
 * @return The reasoning config, or {@link REASONING_NOT_GIVEN} when the
 *   request carries no thinking config.
 * @throws If a thinking config sets neither a level nor a budget, because
 *   there is no defensible effort to guess.
 */
export function openaiReasoningConfig(
  config: GenerateContentConfig,
): OpenAI.Reasoning | typeof REASONING_NOT_GIVEN {
  const thinkingConfig = config.thinkingConfig;
  if (!thinkingConfig) {
    return REASONING_NOT_GIVEN;
  }
  if (thinkingConfig.thinkingLevel) {
    return {
      effort: effortForThinkingLevel(thinkingConfig.thinkingLevel),
      summary: REASONING_SUMMARY,
    };
  }
  if (thinkingConfig.thinkingBudget === undefined) {
    throw new Error(
      'thinking_budget must be set explicitly when a thinking config is ' +
        'provided without a thinking level for OpenAI Responses models. Use ' +
        'thinkingLevel for effort-based reasoning, 0 for minimal reasoning, ' +
        'or -1 for medium reasoning.',
    );
  }
  return {
    effort: thinkingConfig.thinkingBudget === 0 ? 'minimal' : 'medium',
    summary: REASONING_SUMMARY,
  };
}

/** Maps a genai content role onto the Responses message role. */
export function toResponsesRole(
  role?: string,
): OpenAI.Responses.EasyInputMessage['role'] {
  switch (role) {
    case 'model':
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'developer':
      return 'developer';
    default:
      return 'user';
  }
}

/**
 * Accumulates the Responses input items produced by one genai `Content`.
 *
 * Buffered content parts become one message item, which has to be flushed
 * before any non-message item so that the request keeps the part order of the
 * content it came from.
 */
class InputItemBuilder {
  private readonly items: OpenAI.Responses.ResponseInputItem[] = [];
  private pending: OpenAI.Responses.ResponseInputContent[] = [];

  constructor(
    private readonly role: OpenAI.Responses.EasyInputMessage['role'],
  ) {}

  /** Buffers a content part for the current message item. */
  addContent(content: OpenAI.Responses.ResponseInputContent): void {
    this.pending.push(content);
  }

  /** Flushes the buffered parts, then appends a standalone item. */
  addItem(item: OpenAI.Responses.ResponseInputItem): void {
    this.flush();
    this.items.push(item);
  }

  /** Adds text, as an assistant message or as buffered input text. */
  addText(text: string): void {
    if (this.role === 'assistant') {
      this.addItem({type: 'message', role: 'assistant', content: text});
    } else {
      this.addContent({type: 'input_text', text});
    }
  }

  /** Closes the current message item, if any parts are buffered. */
  flush(): void {
    if (this.pending.length === 0) {
      return;
    }
    this.items.push({type: 'message', role: this.role, content: this.pending});
    this.pending = [];
  }

  /** Returns the accumulated items, flushing anything still buffered. */
  build(): OpenAI.Responses.ResponseInputItem[] {
    this.flush();
    return this.items;
  }
}

/**
 * Converts inline data into Responses input content.
 *
 * `Blob.data` is already a base64 string in `@google/genai`, where adk-python
 * holds raw bytes and encodes them here, so it is embedded as it is.
 */
function inlineDataToContent(
  inlineData: Blob,
): OpenAI.Responses.ResponseInputContent {
  const data = inlineData.data ?? '';
  const mimeType = inlineData.mimeType || DEFAULT_INLINE_DATA_MIME_TYPE;
  const url = `data:${mimeType};base64,${data}`;
  if (mimeType.startsWith('image/')) {
    return {type: 'input_image', detail: 'auto', image_url: url};
  }
  return {
    type: 'input_file',
    filename: inlineData.displayName ?? DEFAULT_INLINE_DATA_FILENAME,
    file_data: url,
  };
}

/** Converts file data into Responses input content. */
function fileDataToContent(
  fileData: FileData,
): OpenAI.Responses.ResponseInputContent {
  const fileUri = fileData.fileUri ?? '';
  if (fileData.mimeType?.startsWith('image/')) {
    return {type: 'input_image', detail: 'auto', image_url: fileUri};
  }
  if (fileUri.startsWith('file-')) {
    return {type: 'input_file', file_id: fileUri};
  }
  return {type: 'input_file', file_url: fileUri};
}

/** Converts a part's media, if it carries any, into Responses input content. */
function mediaContent(
  part: Part,
): OpenAI.Responses.ResponseInputContent | undefined {
  if (part.inlineData) {
    return inlineDataToContent(part.inlineData);
  }
  if (part.fileData) {
    return fileDataToContent(part.fileData);
  }
  return undefined;
}

/** Renders an executable-code or code-result part as text. */
function codePartToText(part: Part): string | undefined {
  if (part.executableCode) {
    return `Code:\`\`\`python\n${part.executableCode.code ?? ''}\n\`\`\``;
  }
  if (part.codeExecutionResult) {
    return `Execution Result:\`\`\`code_output\n${part.codeExecutionResult.output ?? ''}\n\`\`\``;
  }
  return undefined;
}

/**
 * Reports a replayed thought that the Responses API cannot accept.
 *
 * Responses reasoning input items must reference a reasoning item id from a
 * prior response. ADK thought parts do not carry one and the API rejects a
 * synthetic id, so continuity runs through `previous_response_id` instead.
 */
function logSkippedReasoningPart(part: Part): void {
  logger.debug(
    part.thoughtSignature
      ? 'Skipping replayed OpenAI Responses reasoning part with encrypted ' +
          'content because no prior reasoning item id is available.'
      : 'Skipping replayed OpenAI Responses reasoning summary because no ' +
          'prior reasoning item id is available.',
  );
}

/** Appends the Responses input a single genai `Part` produces. */
function appendPart(
  builder: InputItemBuilder,
  part: Part,
  role: OpenAI.Responses.EasyInputMessage['role'],
  sanitizer: CallIdSanitizer,
): void {
  if (part.functionResponse) {
    builder.addItem({
      type: 'function_call_output',
      call_id: sanitizer.sanitize(part.functionResponse.id),
      output: serializeToolOutput(part.functionResponse.response),
    });
    return;
  }
  if (part.functionCall) {
    builder.addItem({
      type: 'function_call',
      call_id: sanitizer.sanitize(part.functionCall.id),
      name: part.functionCall.name ?? '',
      arguments: JSON.stringify(part.functionCall.args ?? {}),
    });
    return;
  }
  if (part.thought && (part.text || part.thoughtSignature)) {
    builder.flush();
    logSkippedReasoningPart(part);
    return;
  }
  if (part.text) {
    builder.addText(part.text);
    return;
  }
  const media = mediaContent(part);
  if (media) {
    if (role === 'assistant') {
      logger.warn(MEDIA_IN_ASSISTANT_TURN);
      return;
    }
    builder.addContent(media);
    return;
  }
  const codeText = codePartToText(part);
  if (codeText) {
    builder.addText(codeText);
  }
}

/**
 * Converts one genai `Content` into Responses input items.
 *
 * @param content The content to convert.
 * @param sanitizer The request's call-id sanitizer. Pass the same one for
 *   every content of a request so a call and its output keep one id.
 * @return The input items, possibly empty.
 */
export function contentToResponseInputItems(
  content: Content,
  sanitizer: CallIdSanitizer = new CallIdSanitizer(),
): OpenAI.Responses.ResponseInputItem[] {
  const role = toResponsesRole(content.role);
  const builder = new InputItemBuilder(role);
  for (const part of content.parts ?? []) {
    appendPart(builder, part, role, sanitizer);
  }
  return builder.build();
}

/**
 * Converts a genai `FunctionDeclaration` into a Responses function tool.
 *
 * @param functionDeclaration The declaration to convert.
 * @return The Responses function tool.
 * @throws If the declaration has no name.
 */
export function functionDeclarationToResponseTool(
  functionDeclaration: FunctionDeclaration,
): OpenAI.Responses.FunctionTool {
  const name = functionDeclaration.name;
  if (!name) {
    throw new Error('FunctionDeclaration must have a name.');
  }
  const jsonSchema = functionDeclaration.parametersJsonSchema;
  let parameters: JsonSchemaObject;
  if (isRecord(jsonSchema)) {
    parameters = structuredClone(jsonSchema);
    lowercaseSchemaTypes(parameters);
  } else if (functionDeclaration.parameters) {
    // `required` needs no special handling: the schema conversion carries it
    // through, unlike adk-python's, which rebuilds the document field by field.
    parameters = schemaToJsonObject(functionDeclaration.parameters);
  } else {
    parameters = {type: 'object', properties: {}};
  }

  return {
    type: 'function',
    name,
    description: functionDeclaration.description ?? '',
    parameters,
    strict: false,
  };
}

/**
 * Maps the ADK function-calling mode onto the Responses `tool_choice`.
 *
 * @param config The request's generation config.
 * @return The tool choice, or `undefined` when the mode does not map.
 */
export function toolChoice(
  config: GenerateContentConfig,
): OpenAI.Responses.ToolChoiceOptions | undefined {
  switch (config.toolConfig?.functionCallingConfig?.mode) {
    case FunctionCallingConfigMode.ANY:
      return 'required';
    case FunctionCallingConfigMode.NONE:
      return 'none';
    case FunctionCallingConfigMode.AUTO:
      return 'auto';
    default:
      return undefined;
  }
}

/**
 * Converts Responses usage into ADK usage metadata.
 *
 * @param usage The usage the API reported, if any.
 * @return The ADK usage metadata, or `undefined` when none was reported.
 */
export function toUsageMetadata(
  usage?: OpenAI.Responses.ResponseUsage,
): GenerateContentResponseUsageMetadata | undefined {
  if (!usage) {
    return undefined;
  }
  // adk-python derives the total from the input and output counts when the
  // API omits it. The SDK declares `total_tokens` as always present, so there
  // is nothing here to fall back from.
  return {
    promptTokenCount: usage.input_tokens,
    candidatesTokenCount: usage.output_tokens,
    totalTokenCount: usage.total_tokens,
    cachedContentTokenCount: usage.input_tokens_details?.cached_tokens,
    thoughtsTokenCount: usage.output_tokens_details?.reasoning_tokens,
  };
}

/**
 * Maps a response status onto an ADK finish reason.
 *
 * @param response The response to read.
 * @return The finish reason, or `undefined` while the response is still
 *   running.
 */
export function mapFinishReason(
  response: OpenAI.Responses.Response,
): FinishReason | undefined {
  switch (response.status) {
    case 'completed':
      return FinishReason.STOP;
    case 'incomplete':
      return MAX_TOKEN_REASONS.has(response.incomplete_details?.reason ?? '')
        ? FinishReason.MAX_TOKENS
        : FinishReason.OTHER;
    case 'failed':
    case 'cancelled':
      return FinishReason.OTHER;
    default:
      return undefined;
  }
}

/**
 * Converts an output message into ADK parts.
 *
 * @param item The message item.
 * @return One text part per content entry, a refusal carrying
 *   `OpenAI refusal: ` so it is not silently dropped.
 */
export function messageContentParts(
  item: OpenAI.Responses.ResponseOutputMessage,
): Part[] {
  return (item.content ?? []).map((content) =>
    content.type === 'refusal'
      ? {text: REFUSAL_PREFIX + content.refusal}
      : {text: content.text},
  );
}

/** Builds one thought part, carrying the item's encrypted content. */
function thoughtPart(text: string, encryptedContent?: string): Part {
  const part: Part = {text, thought: true};
  if (encryptedContent) {
    part.thoughtSignature = encryptedContent;
  }
  return part;
}

/**
 * Converts a reasoning item into ADK thought parts and its metadata.
 *
 * A reasoning item that carries only encrypted content still produces one
 * part, so that redacted reasoning is not lost.
 *
 * @param item The reasoning item.
 * @return The thought parts and the metadata describing the item.
 */
export function reasoningParts(item: OpenAI.Responses.ResponseReasoningItem): {
  parts: Part[];
  metadata: Record<string, unknown>;
} {
  const encryptedContent = item.encrypted_content ?? undefined;
  const parts: Part[] = [];
  for (const entry of [...(item.summary ?? []), ...(item.content ?? [])]) {
    if (entry.text) {
      parts.push(thoughtPart(entry.text, encryptedContent));
    }
  }

  const metadata: Record<string, unknown> = {};
  if (encryptedContent) {
    metadata['encrypted_content'] = encryptedContent;
    if (parts.length === 0) {
      parts.push({thought: true, thoughtSignature: encryptedContent});
    }
  }
  if (item.id) {
    metadata['id'] = item.id;
  }
  return {parts, metadata};
}

/**
 * Converts a function tool call into an ADK function-call part.
 *
 * @param item The function call item.
 * @return The part. A call missing its name is logged and yields `''`.
 */
export function functionCallPart(
  item: OpenAI.Responses.ResponseFunctionToolCall,
): Part {
  if (!item.name) {
    logger.warn('OpenAI Responses function call is missing a name.');
  }
  return {
    functionCall: {
      id: item.call_id || item.id,
      name: item.name ?? '',
      args: loadsJsonObject(item.arguments),
    },
  };
}

/** The `openai_response` block attached to a converted response. */
interface ResponseMetadata {
  id: string;
  status?: string;
  output: OpenAI.Responses.ResponseOutputItem[];
  usage?: OpenAI.Responses.ResponseUsage;
  reasoning?: Array<Record<string, unknown>>;
  unmapped_output?: OpenAI.Responses.ResponseOutputItem[];
}

/**
 * Converts a Responses API response into an `LlmResponse`.
 *
 * @param response The response to convert.
 * @param options.includeResponseMetadata Whether to attach the raw response
 *   under `customMetadata.openai_response`.
 * @return The ADK response.
 */
export function responseToLlmResponse(
  response: OpenAI.Responses.Response,
  {includeResponseMetadata}: {includeResponseMetadata: boolean},
): LlmResponse {
  const parts: Part[] = [];
  const reasoning: Array<Record<string, unknown>> = [];
  const unmappedOutput: OpenAI.Responses.ResponseOutputItem[] = [];

  for (const item of response.output ?? []) {
    switch (item.type) {
      case 'message':
        parts.push(...messageContentParts(item));
        break;
      case 'function_call':
        parts.push(functionCallPart(item));
        break;
      case 'reasoning': {
        const converted = reasoningParts(item);
        parts.push(...converted.parts);
        if (Object.keys(converted.metadata).length > 0) {
          reasoning.push(converted.metadata);
        }
        break;
      }
      default:
        unmappedOutput.push(item);
    }
  }

  const llmResponse: LlmResponse = {
    usageMetadata: toUsageMetadata(response.usage),
    finishReason: mapFinishReason(response),
    modelVersion: response.model,
    interactionId: response.id,
  };
  if (parts.length > 0) {
    llmResponse.content = {role: 'model', parts};
  }
  if (includeResponseMetadata) {
    const metadata: ResponseMetadata = {
      id: response.id,
      status: response.status,
      output: response.output ?? [],
    };
    if (response.usage) {
      metadata.usage = response.usage;
    }
    if (reasoning.length > 0) {
      metadata.reasoning = reasoning;
    }
    if (unmappedOutput.length > 0) {
      metadata.unmapped_output = unmappedOutput;
    }
    llmResponse.customMetadata = {openai_response: metadata};
  }

  const finishReason = llmResponse.finishReason;
  if (finishReason && finishReason !== FinishReason.STOP) {
    llmResponse.errorCode = finishReason;
    const error = response.error ?? response.incomplete_details;
    if (error) {
      llmResponse.errorMessage = JSON.stringify(error);
    }
  }
  return llmResponse;
}
