/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger, LlmRequest} from '@google/adk';
import {
  Content,
  ContentUnion,
  FileData,
  FunctionCall,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  FunctionResponse,
  Blob as GenAiBlob,
  GenerateContentConfig,
  Part,
  PartUnion,
  ThinkingLevel,
  ToolUnion,
} from '@google/genai';
import type {
  EasyInputMessage,
  FunctionTool,
  ResponseCreateParamsBase,
  ResponseIncludable,
  ResponseInput,
  ResponseInputContent,
  ResponseInputItem,
  ResponseTextConfig,
  ServiceTier,
  ToolChoiceOptions,
} from 'openai/resources/responses/responses';
import type {Reasoning, ReasoningEffort} from 'openai/resources/shared';
import {
  enforceStrictOpenAiSchema,
  isJsonObject,
  JsonObject,
} from './openai_schema.js';

const logger = getLogger();

/** A call id the Responses API accepts verbatim. */
const VALID_CALL_ID = /^[a-zA-Z0-9_-]+$/;

/** Characters the Responses API rejects in a `json_schema` format name. */
const INVALID_SCHEMA_NAME_CHARS = /[^a-zA-Z0-9_-]/g;

/** Effort the Responses API applies for each genai thinking level. */
const EFFORT_BY_THINKING_LEVEL: Record<ThinkingLevel, ReasoningEffort> = {
  [ThinkingLevel.THINKING_LEVEL_UNSPECIFIED]: 'medium',
  [ThinkingLevel.MINIMAL]: 'minimal',
  [ThinkingLevel.LOW]: 'low',
  [ThinkingLevel.MEDIUM]: 'medium',
  [ThinkingLevel.HIGH]: 'high',
};

/**
 * The Responses request body.
 *
 * The Responses API accepts `stop`, but the SDK's params type does not declare
 * it. openai-node has no `extra_body` escape hatch — the params object is the
 * body — so the field is declared here instead.
 */
export interface ResponsesRequestBody extends ResponseCreateParamsBase {
  stop?: string[];
}

/** The model-level settings {@link buildResponsesRequest} folds into a body. */
export interface ResponsesRequestOptions {
  model: string;
  stream: boolean;
  store?: boolean;
  include?: ResponseIncludable[];
  reasoning?: Reasoning;
  parallelToolCalls?: boolean;
  truncation?: 'auto' | 'disabled';
  serviceTier?: ServiceTier;
  extraRequestArgs?: Partial<ResponsesRequestBody>;
}

/**
 * Maps function call ids that the Responses API would reject onto ids it
 * accepts.
 *
 * One sanitizer serves one request: a function call and the function response
 * that answers it must resolve to the same id, or the API rejects the turn.
 */
export class CallIdSanitizer {
  private readonly fallbackById = new Map<string, string>();
  private nextFallback = 0;

  sanitize(callId?: string): string {
    if (callId && VALID_CALL_ID.test(callId)) {
      return callId;
    }
    if (!callId) {
      return this.mintFallback();
    }
    let fallback = this.fallbackById.get(callId);
    if (fallback === undefined) {
      fallback = this.mintFallback();
      this.fallbackById.set(callId, fallback);
    }
    return fallback;
  }

  private mintFallback(): string {
    return `call_adk_fallback_${this.nextFallback++}`;
  }
}

/**
 * Collects the input items for one ADK content.
 *
 * Consecutive content blocks are buffered so they leave as a single message
 * item, and the buffer is flushed before anything that is not a content block
 * so the emitted items keep the order of the parts they came from.
 */
class ResponseInputItemsBuilder {
  private readonly items: ResponseInputItem[] = [];
  private messageParts: ResponseInputContent[] = [];

  constructor(private readonly role: EasyInputMessage['role']) {}

  addContent(content: ResponseInputContent): void {
    this.messageParts.push(content);
  }

  addItem(item: ResponseInputItem): void {
    this.flush();
    this.items.push(item);
  }

  addAssistantText(text: string): void {
    this.addItem({type: 'message', role: 'assistant', content: text});
  }

  flush(): void {
    if (this.messageParts.length === 0) {
      return;
    }
    this.items.push({
      type: 'message',
      role: this.role,
      content: this.messageParts,
    });
    this.messageParts = [];
  }

  build(): ResponseInputItem[] {
    this.flush();
    return this.items;
  }
}

/** Returns a Part's text, or the empty string when it carries none. */
function partText(part: Part): string {
  return part.text ?? '';
}

/** Narrows a {@link ContentUnion} member to a {@link Content}. */
function isContent(value: Content | PartUnion): value is Content {
  return typeof value !== 'string' && 'parts' in value;
}

/** Concatenates the text of one system-instruction element. */
function instructionElementText(value: PartUnion): string {
  return typeof value === 'string' ? value : partText(value);
}

/**
 * Serializes ADK system instructions into the Responses `instructions` field.
 *
 * Returns `undefined` when the instructions carry no text, because the
 * Responses API treats an empty instruction differently from an absent one.
 */
export function serializeSystemInstruction(
  systemInstruction?: ContentUnion,
): string | undefined {
  if (!systemInstruction) {
    return undefined;
  }
  let text: string;
  if (Array.isArray(systemInstruction)) {
    text = systemInstruction.map(instructionElementText).join('');
  } else if (isContent(systemInstruction)) {
    text = (systemInstruction.parts ?? []).map(partText).join('');
  } else {
    text = instructionElementText(systemInstruction);
  }
  return text || undefined;
}

/**
 * Lowercases every nested JSON Schema `type` in place.
 *
 * genai emits the protobuf spelling (`OBJECT`, `STRING`); JSON Schema, and so
 * the Responses API, requires the lowercase form.
 */
export function lowercaseSchemaTypes(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      lowercaseSchemaTypes(item);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }
  const schemaType = value['type'];
  if (typeof schemaType === 'string') {
    value['type'] = schemaType.toLowerCase();
  }
  for (const child of Object.values(value)) {
    lowercaseSchemaTypes(child);
  }
}

/** Deep-copies a schema and rewrites it into the JSON Schema dialect. */
export function schemaToJsonObject(schema: unknown): JsonObject {
  if (!isJsonObject(schema)) {
    return {};
  }
  const copy = structuredClone(schema);
  lowercaseSchemaTypes(copy);
  return copy;
}

/** Returns a `json_schema` format name the Responses API accepts. */
function sanitizeSchemaName(name: string): string {
  return name.replace(INVALID_SCHEMA_NAME_CHARS, '_') || 'schema';
}

/**
 * Maps ADK structured-output settings onto the Responses `text` field.
 *
 * Unlike adk-python there is no schema class to fall back on for the format
 * name: a genai schema is a plain object, so the name comes from its `title`
 * or from the literal `schema`.
 */
export function responseTextConfig(
  config: GenerateContentConfig,
): ResponseTextConfig | undefined {
  const schema = config.responseSchema ?? config.responseJsonSchema;
  if (schema) {
    const schemaObject = schemaToJsonObject(schema);
    if (Object.keys(schemaObject).length === 0) {
      return undefined;
    }
    const title = schemaObject['title'];
    const name = sanitizeSchemaName(typeof title === 'string' ? title : '');
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

/**
 * Maps an ADK thinking config onto the Responses reasoning config.
 *
 * Returns `undefined` when no thinking config was given, which leaves the
 * model-level `reasoning` setting in place.
 *
 * @throws when a thinking config sets neither a level nor a budget.
 */
export function reasoningFromThinkingConfig(
  config: GenerateContentConfig,
): Reasoning | undefined {
  const thinkingConfig = config.thinkingConfig;
  if (!thinkingConfig) {
    return undefined;
  }
  const {thinkingLevel, thinkingBudget} = thinkingConfig;
  if (thinkingLevel) {
    return {
      effort: EFFORT_BY_THINKING_LEVEL[thinkingLevel],
      summary: 'concise',
    };
  }
  if (thinkingBudget === undefined) {
    throw new Error(
      'thinking_budget must be set explicitly when ThinkingConfig is provided' +
        ' without thinking_level for OpenAI Responses models. Use' +
        ' thinking_level for effort-based reasoning, 0 for minimal reasoning,' +
        ' or -1 for medium reasoning.',
    );
  }
  // Responses reasoning is effort-based rather than budget-based, so only the
  // "no thinking at all" budget survives the translation.
  return {
    effort: thinkingBudget === 0 ? 'minimal' : 'medium',
    summary: 'concise',
  };
}

/** Maps an ADK content role onto a Responses message role. */
function roleToResponsesRole(role?: string): EasyInputMessage['role'] {
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

/** Serializes a tool result into the string the Responses API expects. */
export function serializeJsonValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (isJsonObject(value)) {
    const content = value['content'];
    if (Array.isArray(content) && content.length > 0) {
      return content.map(serializeContentBlock).join('\n');
    }
    if (typeof content === 'string' && content) {
      return content;
    }
    const result = value['result'];
    if ('result' in value && result !== null && result !== undefined) {
      return typeof result === 'string' ? result : JSON.stringify(result);
    }
  }
  return JSON.stringify(value);
}

/** Serializes one block of an MCP-shaped tool result. */
function serializeContentBlock(block: unknown): string {
  if (!isJsonObject(block)) {
    return String(block);
  }
  if (block['type'] === 'text' && 'text' in block) {
    return String(block['text']);
  }
  return JSON.stringify(block);
}

/** Parses tool-call arguments, tolerating anything the model may emit. */
export function loadJsonObject(value?: string): JsonObject {
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
  return isJsonObject(parsed) ? parsed : {};
}

/** Builds the data URL for an inline-data part. */
function inlineDataToResponseContent(blob: GenAiBlob): ResponseInputContent {
  // genai already carries inline data as a base64 string, so unlike
  // adk-python there is nothing left to encode here.
  const mimeType = blob.mimeType ?? 'application/octet-stream';
  const dataUrl = `data:${mimeType};base64,${blob.data ?? ''}`;
  if (mimeType.startsWith('image/')) {
    return {type: 'input_image', detail: 'auto', image_url: dataUrl};
  }
  return {
    type: 'input_file',
    filename: blob.displayName ?? 'inline_data',
    file_data: dataUrl,
  };
}

/** Maps a file-data part onto a Responses content block. */
function fileDataToResponseContent(fileData: FileData): ResponseInputContent {
  const fileUri = fileData.fileUri ?? '';
  if ((fileData.mimeType ?? '').startsWith('image/')) {
    return {type: 'input_image', detail: 'auto', image_url: fileUri};
  }
  if (fileUri.startsWith('file-')) {
    return {type: 'input_file', file_id: fileUri};
  }
  return {type: 'input_file', file_url: fileUri};
}

/** Maps a function call onto a Responses input item. */
function functionCallToResponseItem(
  functionCall: FunctionCall,
  sanitizer: CallIdSanitizer,
): ResponseInputItem {
  return {
    type: 'function_call',
    call_id: sanitizer.sanitize(functionCall.id),
    name: functionCall.name ?? '',
    arguments: JSON.stringify(functionCall.args ?? {}),
  };
}

/** Maps a function response onto a Responses input item. */
function functionResponseToResponseItem(
  functionResponse: FunctionResponse,
  sanitizer: CallIdSanitizer,
): ResponseInputItem {
  return {
    type: 'function_call_output',
    call_id: sanitizer.sanitize(functionResponse.id),
    output: serializeJsonValue(functionResponse.response),
  };
}

/** Maps a media part onto a Responses content block, if it carries media. */
function mediaToResponseContent(part: Part): ResponseInputContent | undefined {
  if (part.inlineData) {
    return inlineDataToResponseContent(part.inlineData);
  }
  if (part.fileData) {
    return fileDataToResponseContent(part.fileData);
  }
  return undefined;
}

/** Renders a code or code-result part as text the model can read. */
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
 * Reports that a replayed reasoning part was dropped.
 *
 * A Responses reasoning input item has to reference a reasoning item id from a
 * real prior response. ADK thought parts do not carry one and the API rejects
 * a synthetic id, so continuity runs through `previous_response_id` instead.
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

/** Adds one part to the builder for the content being converted. */
function addPartToBuilder(
  part: Part,
  role: EasyInputMessage['role'],
  builder: ResponseInputItemsBuilder,
  sanitizer: CallIdSanitizer,
): void {
  if (part.functionResponse) {
    builder.addItem(
      functionResponseToResponseItem(part.functionResponse, sanitizer),
    );
    return;
  }
  if (part.functionCall) {
    builder.addItem(functionCallToResponseItem(part.functionCall, sanitizer));
    return;
  }
  if (part.thought && (part.text || part.thoughtSignature)) {
    builder.flush();
    logSkippedReasoningPart(part);
    return;
  }
  if (part.text) {
    if (role === 'assistant') {
      builder.addAssistantText(part.text);
    } else {
      builder.addContent({type: 'input_text', text: part.text});
    }
    return;
  }
  const media = mediaToResponseContent(part);
  if (media) {
    if (role === 'assistant') {
      logger.warn('Media data is not supported in Responses assistant turns.');
      return;
    }
    builder.addContent(media);
    return;
  }
  const codeText = codePartToText(part);
  if (!codeText) {
    return;
  }
  if (role === 'assistant') {
    builder.addAssistantText(codeText);
  } else {
    builder.addContent({type: 'input_text', text: codeText});
  }
}

/** Converts one ADK content into Responses API input items. */
export function contentToResponseInputItems(
  content: Content,
  sanitizer: CallIdSanitizer,
): ResponseInputItem[] {
  const role = roleToResponsesRole(content.role);
  const builder = new ResponseInputItemsBuilder(role);
  for (const part of content.parts ?? []) {
    addPartToBuilder(part, role, builder, sanitizer);
  }
  return builder.build();
}

/** Converts an ADK function declaration into a Responses function tool. */
export function functionDeclarationToResponseTool(
  declaration: FunctionDeclaration,
): FunctionTool {
  if (!declaration.name) {
    throw new Error('FunctionDeclaration must have a name.');
  }
  const parameters = toolParameters(declaration);
  const required = declaration.parameters?.required;
  if (required?.length) {
    parameters['required'] = required;
  }
  return {
    type: 'function',
    name: declaration.name,
    description: declaration.description ?? '',
    parameters,
    strict: false,
  };
}

/** Resolves the JSON Schema for a function declaration's parameters. */
function toolParameters(declaration: FunctionDeclaration): JsonObject {
  if (declaration.parametersJsonSchema) {
    return schemaToJsonObject(declaration.parametersJsonSchema);
  }
  if (declaration.parameters) {
    return schemaToJsonObject(declaration.parameters);
  }
  return {type: 'object', properties: {}};
}

/** Maps the ADK function-calling mode onto the Responses tool choice. */
export function toolChoiceFromConfig(
  config: GenerateContentConfig,
): ToolChoiceOptions | undefined {
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

/** Returns the function declarations a genai tool carries, if any. */
function toolFunctionDeclarations(tool: ToolUnion): FunctionDeclaration[] {
  return 'functionDeclarations' in tool
    ? (tool.functionDeclarations ?? [])
    : [];
}

/** Converts every declared tool into a Responses function tool. */
function responseTools(config: GenerateContentConfig): FunctionTool[] {
  return (config.tools ?? [])
    .flatMap(toolFunctionDeclarations)
    .map(functionDeclarationToResponseTool);
}

/** Converts the request contents into Responses input items. */
function responseInput(llmRequest: LlmRequest): ResponseInput {
  // One sanitizer per request: a call and its response must agree on the id.
  const sanitizer = new CallIdSanitizer();
  return llmRequest.contents.flatMap((content) =>
    contentToResponseInputItems(content, sanitizer),
  );
}

/**
 * Returns a copy of `body` without the keys whose value is `undefined`.
 *
 * An absent key and a key set to `undefined` are not the same request to the
 * Responses API, so the unset ones are dropped rather than serialized.
 */
function withoutUndefinedValues<T extends object>(body: T): T {
  const result: Partial<T> = {};
  for (const key of Object.keys(body) as Array<keyof T>) {
    const value = body[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

/** Builds the Responses API request body for one ADK request. */
export function buildResponsesRequest(
  llmRequest: LlmRequest,
  options: ResponsesRequestOptions,
): ResponsesRequestBody {
  const config = llmRequest.config ?? {};
  const tools = responseTools(config);
  return withoutUndefinedValues<ResponsesRequestBody>({
    model: llmRequest.model ?? options.model,
    input: responseInput(llmRequest),
    stream: options.stream,
    instructions: serializeSystemInstruction(config.systemInstruction),
    previous_response_id: llmRequest.previousInteractionId,
    temperature: config.temperature,
    top_p: config.topP,
    max_output_tokens: config.maxOutputTokens,
    stop: config.stopSequences?.length ? config.stopSequences : undefined,
    text: responseTextConfig(config),
    reasoning: reasoningFromThinkingConfig(config) ?? options.reasoning,
    tools: tools.length ? tools : undefined,
    tool_choice: toolChoiceFromConfig(config),
    store: options.store,
    include: options.include,
    parallel_tool_calls: options.parallelToolCalls,
    truncation: options.truncation,
    service_tier: options.serviceTier,
    ...options.extraRequestArgs,
  });
}
