/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conversion between ADK request/response types and the OpenAI Responses API
 * wire shapes.
 *
 * Ported from `src/google/adk/labs/openai/_openai_responses_llm.py` in
 * google/adk-python.
 */

import {
  Blob,
  Content,
  FileData,
  FinishReason,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';

import {extractSystemInstruction} from '../../models/interactions_utils.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {genaiSchemaToJsonSchema} from '../../utils/genai_schema_to_json.js';
import {logger} from '../../utils/logger.js';
import {SchemaLike, toJsonSchema} from '../../utils/schema.js';
import {isZodSchema} from '../../utils/simple_zod_to_json.js';

import {
  enforceStrictOpenAiSchema,
  isRecord,
  lowercaseSchemaTypes,
} from './openai_schema.js';

/** Prefix ADK puts in front of a model refusal so it survives as text. */
const REFUSAL_PREFIX = 'OpenAI refusal: ';

/** Prefix of the call id ADK invents for a missing or invalid one. */
const FALLBACK_CALL_ID_PREFIX = 'call_adk_fallback_';

/** The call id shape the Responses API accepts. */
const VALID_CALL_ID = /^[a-zA-Z0-9_-]+$/;

/** Characters OpenAI rejects in a `json_schema` name. */
const INVALID_SCHEMA_NAME_CHARS = /[^a-zA-Z0-9_-]/g;

/** Name used for a structured-output schema that carries no `title`. */
const DEFAULT_SCHEMA_NAME = 'schema';

/** Mime type assumed for inline data that declares none. */
const DEFAULT_INLINE_MIME_TYPE = 'application/octet-stream';

/** Filename assumed for an inline file part that declares none. */
const DEFAULT_INLINE_FILENAME = 'inline_data';

/** The `thinkingLevel` value that means "the caller did not choose one". */
const UNSPECIFIED_THINKING_LEVEL = 'thinking_level_unspecified';

/** Reasoning effort used when no more specific level is available. */
const DEFAULT_REASONING_EFFORT = 'medium';

/** Reasoning summary ADK asks for whenever it derives a reasoning config. */
const REASONING_SUMMARY = 'concise';

const ASSISTANT_MEDIA_WARNING =
  'Media data is not supported in Responses assistant turns.';

const THINKING_BUDGET_REQUIRED_MESSAGE =
  'thinkingBudget must be set explicitly when thinkingConfig is provided ' +
  'without thinkingLevel for OpenAI Responses models. Use thinkingLevel for ' +
  'effort-based reasoning, 0 for minimal reasoning, or -1 for medium ' +
  'reasoning.';

/**
 * Narrows a wire field to the optional form ADK types use.
 *
 * The API sends `null` for a field it has no value for rather than omitting
 * it, so the wire interfaces below accept `null` on every optional field and
 * the readers convert it here.
 */
export function optional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

/** Reasoning configuration sent to the Responses API. */
export interface OpenAIReasoningConfig {
  /** Effort level, one of `minimal`, `low`, `medium`, `high`. */
  effort: string;
  /** Summary verbosity. ADK sends `concise` when it derives the config. */
  summary?: string;
}

/** A content block inside a Responses `message` or `reasoning` output item. */
export interface OpenAIContentPart {
  /** Block kind, e.g. `output_text`, `refusal`, `summary_text`. */
  type?: string | null;
  text?: string | null;
  refusal?: string | null;
}

/**
 * One item of a Responses API `output` array.
 *
 * `type` discriminates the item; the remaining fields are the ones ADK reads
 * from the item kinds it maps. An item of any other kind is passed through to
 * `unmapped_output` untouched.
 */
export interface OpenAIOutputItem {
  type?: string | null;
  id?: string | null;
  role?: string | null;
  content?: OpenAIContentPart[] | null;
  call_id?: string | null;
  name?: string | null;
  arguments?: string | null;
  summary?: OpenAIContentPart[] | null;
  encrypted_content?: string | null;
}

/** Token counts as the Responses API reports them. */
export interface OpenAIUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  input_tokens_details?: {cached_tokens?: number | null} | null;
  output_tokens_details?: {reasoning_tokens?: number | null} | null;
}

/** A Responses API response object. */
export interface OpenAIResponse {
  id?: string | null;
  model?: string | null;
  status?: string | null;
  output?: OpenAIOutputItem[] | null;
  usage?: OpenAIUsage | null;
  error?: unknown;
  incomplete_details?: {reason?: string | null} | null;
}

/** One server-sent event of a streamed Responses request. */
export interface OpenAIStreamEvent {
  type?: string | null;
  delta?: string | null;
  text?: string | null;
  name?: string | null;
  arguments?: string | null;
  call_id?: string | null;
  item_id?: string | null;
  output_index?: number | null;
  content_index?: number | null;
  summary_index?: number | null;
  item?: OpenAIOutputItem | null;
  part?: OpenAIContentPart | null;
  response?: OpenAIResponse | null;
}

/** A content block of a Responses input message. */
export type ResponsesInputContent =
  | {type: 'input_text'; text: string}
  | {type: 'input_image'; detail: string; image_url: string}
  | {
      type: 'input_file';
      filename?: string;
      file_data?: string;
      file_id?: string;
      file_url?: string;
    };

/** One item of the Responses API `input` array. */
export type ResponsesInputItem =
  | {type: 'message'; role: string; content: string | ResponsesInputContent[]}
  | {type: 'function_call'; call_id: string; name: string; arguments: string}
  | {type: 'function_call_output'; call_id: string; output: string};

/** A function tool as the Responses API declares it. */
export interface ResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

/** The `text` field of a Responses request, for structured output. */
export interface ResponsesTextConfig {
  format:
    | {
        type: 'json_schema';
        name: string;
        strict: boolean;
        schema: Record<string, unknown>;
      }
    | {type: 'json_object'};
}

/** The model-level request fields {@link buildResponsesCreateParams} applies. */
export interface ResponsesRequestOptions {
  /** Model to call when the request does not name one. */
  model: string;
  store?: boolean;
  include?: string[];
  reasoning?: OpenAIReasoningConfig;
  parallelToolCalls?: boolean;
  truncation?: string;
  serviceTier?: string;
  extraRequestArgs?: Record<string, unknown>;
}

/** How much of the raw Responses payload to keep on the ADK response. */
export interface ResponseConversionOptions {
  includeResponseMetadata: boolean;
}

/**
 * Maps invalid or missing function call ids onto ids the Responses API
 * accepts.
 *
 * One sanitizer serves one request, so a `functionCall` and the
 * `functionResponse` that answers it map the same bad id to the same
 * replacement, and the fallback numbering restarts on the next request.
 */
export class CallIdSanitizer {
  private readonly mapping = new Map<string, string>();
  private nextFallback = 0;

  /** Returns `callId` when the API accepts it, or a stable replacement. */
  sanitize(callId?: string): string {
    if (callId && VALID_CALL_ID.test(callId)) {
      return callId;
    }
    if (!callId) {
      return this.newFallbackId();
    }
    let fallback = this.mapping.get(callId);
    if (fallback === undefined) {
      fallback = this.newFallbackId();
      this.mapping.set(callId, fallback);
    }
    return fallback;
  }

  private newFallbackId(): string {
    return `${FALLBACK_CALL_ID_PREFIX}${this.nextFallback++}`;
  }
}

/** Renders one entry of an MCP-style `content` array as text. */
function contentEntryToText(entry: unknown): string {
  if (!isRecord(entry)) {
    return String(entry);
  }
  if (entry['type'] === 'text' && 'text' in entry) {
    return String(entry['text']);
  }
  return JSON.stringify(entry);
}

/**
 * Serializes a tool result into the string a `function_call_output` carries.
 *
 * An MCP-style `{content: [...]}` result is flattened to its text so the model
 * reads the tool output rather than the envelope around it.
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
      return content.map(contentEntryToText).join('\n');
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

/**
 * Parses function-call arguments, degrading to `{}` rather than throwing.
 *
 * The model produces this string, so malformed JSON is a model error rather
 * than a bug, and failing the whole turn over it is worse than calling the
 * tool with no arguments.
 */
export function loadsJsonObject(
  value?: string | null,
): Record<string, unknown> {
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

/** Maps an ADK content role onto the role the Responses API expects. */
function toResponsesRole(role?: string): string {
  if (role === 'model' || role === 'assistant') {
    return 'assistant';
  }
  if (role === 'system' || role === 'developer') {
    return role;
  }
  return 'user';
}

/** Renders inline data as an `input_image` or an `input_file` data URL. */
function inlineDataToContent(inlineData: Blob): ResponsesInputContent {
  const mimeType = inlineData.mimeType || DEFAULT_INLINE_MIME_TYPE;
  const dataUrl = `data:${mimeType};base64,${inlineData.data ?? ''}`;
  if (mimeType.startsWith('image/')) {
    return {type: 'input_image', detail: 'auto', image_url: dataUrl};
  }
  return {
    type: 'input_file',
    filename: inlineData.displayName || DEFAULT_INLINE_FILENAME,
    file_data: dataUrl,
  };
}

/** Renders a file reference as an `input_image` or an `input_file`. */
function fileDataToContent(fileData: FileData): ResponsesInputContent {
  const fileUri = fileData.fileUri ?? '';
  if ((fileData.mimeType ?? '').startsWith('image/')) {
    return {type: 'input_image', detail: 'auto', image_url: fileUri};
  }
  if (fileUri.startsWith('file-')) {
    return {type: 'input_file', file_id: fileUri};
  }
  return {type: 'input_file', file_url: fileUri};
}

/** Renders an inline-data or file-data part as a message content block. */
function mediaPartToContent(part: Part): ResponsesInputContent | undefined {
  if (part.inlineData) {
    return inlineDataToContent(part.inlineData);
  }
  if (part.fileData) {
    return fileDataToContent(part.fileData);
  }
  return undefined;
}

/**
 * Renders an executable-code or code-result part as text.
 *
 * The Responses API has no input item for either, so both are carried as text
 * the way the other non-Gemini adapters carry them.
 */
function codePartToText(part: Part): string | undefined {
  if (part.executableCode) {
    return `Code:\`\`\`python\n${part.executableCode.code ?? ''}\n\`\`\``;
  }
  if (part.codeExecutionResult) {
    return `Execution Result:\`\`\`code_output\n${
      part.codeExecutionResult.output ?? ''
    }\n\`\`\``;
  }
  return undefined;
}

/**
 * Reports a replayed thought part that cannot be sent back.
 *
 * A Responses reasoning input item must reference a reasoning item id from a
 * real prior response. ADK thought parts do not carry one and the API rejects
 * a synthetic id, so the part is dropped; continuity comes from
 * `previous_response_id` instead.
 */
function logSkippedThought(part: Part): void {
  logger.debug(
    part.thoughtSignature
      ? 'Skipping replayed OpenAI Responses reasoning part with encrypted ' +
          'content because no prior reasoning item id is available.'
      : 'Skipping replayed OpenAI Responses reasoning summary because no ' +
          'prior reasoning item id is available.',
  );
}

/**
 * Collects the input items of one ADK content.
 *
 * Consecutive message blocks buffer into one message item, which has to be
 * flushed before any non-message item so the turn keeps its original order.
 */
class ResponsesInputBuilder {
  private readonly items: ResponsesInputItem[] = [];
  private messageParts: ResponsesInputContent[] = [];

  constructor(private readonly role: string) {}

  /** Buffers one block into the message being built. */
  addBlock(block: ResponsesInputContent): void {
    this.messageParts.push(block);
  }

  /** Emits a non-message item after the buffered message. */
  addItem(item: ResponsesInputItem): void {
    this.flush();
    this.items.push(item);
  }

  /** Emits an assistant message, whose content is a bare string. */
  addAssistantText(text: string): void {
    this.flush();
    this.items.push({type: 'message', role: 'assistant', content: text});
  }

  /** Emits the buffered message, if any. */
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

  /** Returns every item, flushing whatever is still buffered. */
  build(): ResponsesInputItem[] {
    this.flush();
    return this.items;
  }
}

/** Adds the Responses input for one ADK part to `builder`. */
function appendPartToInput(
  builder: ResponsesInputBuilder,
  part: Part,
  role: string,
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
    logSkippedThought(part);
    return;
  }
  if (part.text) {
    if (role === 'assistant') {
      builder.addAssistantText(part.text);
    } else {
      builder.addBlock({type: 'input_text', text: part.text});
    }
    return;
  }
  const mediaBlock = mediaPartToContent(part);
  if (mediaBlock) {
    if (role === 'assistant') {
      logger.warn(ASSISTANT_MEDIA_WARNING);
      return;
    }
    builder.addBlock(mediaBlock);
    return;
  }
  const codeText = codePartToText(part);
  if (!codeText) {
    return;
  }
  if (role === 'assistant') {
    builder.addAssistantText(codeText);
  } else {
    builder.addBlock({type: 'input_text', text: codeText});
  }
}

/** Converts one ADK content into Responses API input items. */
export function contentToResponsesInputItems(
  content: Content,
  sanitizer: CallIdSanitizer = new CallIdSanitizer(),
): ResponsesInputItem[] {
  const role = toResponsesRole(content.role);
  const builder = new ResponsesInputBuilder(role);
  for (const part of content.parts ?? []) {
    appendPartToInput(builder, part, role, sanitizer);
  }
  return builder.build();
}

/**
 * Converts a whole conversation into Responses API input items.
 *
 * One sanitizer covers the whole request so a replaced call id stays the same
 * across the turns that reference it.
 */
export function toResponsesInput(contents: Content[]): ResponsesInputItem[] {
  const sanitizer = new CallIdSanitizer();
  return contents.flatMap((content) =>
    contentToResponsesInputItems(content, sanitizer),
  );
}

/** Renders the parameter schema of one function declaration. */
function toolParameters(
  declaration: FunctionDeclaration,
): Record<string, unknown> {
  if (isRecord(declaration.parametersJsonSchema)) {
    const parameters = structuredClone(declaration.parametersJsonSchema);
    lowercaseSchemaTypes(parameters);
    return parameters;
  }
  if (!declaration.parameters) {
    return {type: 'object', properties: {}};
  }
  // `genaiSchemaToJsonSchema` carries `required` through, so unlike the Python
  // reference there is nothing left to re-add here.
  return genaiSchemaToJsonSchema(declaration.parameters);
}

/**
 * Converts an ADK function declaration into a Responses function tool.
 *
 * @throws If the declaration has no name, which the API requires.
 */
export function functionDeclarationToResponsesTool(
  declaration: FunctionDeclaration,
): ResponsesTool {
  if (!declaration.name) {
    throw new Error('FunctionDeclaration must have a name.');
  }
  return {
    type: 'function',
    name: declaration.name,
    description: declaration.description ?? '',
    parameters: toolParameters(declaration),
    strict: false,
  };
}

/** Collects the Responses tools declared across every tool on a config. */
function collectResponsesTools(config: GenerateContentConfig): ResponsesTool[] {
  const tools: ResponsesTool[] = [];
  for (const tool of config.tools ?? []) {
    if ('functionDeclarations' in tool && tool.functionDeclarations) {
      for (const declaration of tool.functionDeclarations) {
        tools.push(functionDeclarationToResponsesTool(declaration));
      }
    }
  }
  return tools;
}

/** Maps the ADK function-calling mode onto a Responses `tool_choice`. */
export function toolChoiceFromConfig(
  config: GenerateContentConfig,
): string | undefined {
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
 * Returns true when `value` can be rendered by {@link toJsonSchema}.
 *
 * `GenerateContentConfig.responseSchema` is declared `unknown` because it
 * accepts a Zod type or a genai `Schema`; both are objects, and
 * {@link toJsonSchema} dispatches between them. This rejects the non-object
 * values the declared type also admits.
 */
function isSchemaLike(value: unknown): value is SchemaLike {
  return isZodSchema(value) || isRecord(value);
}

/** Renders the configured output schema as plain JSON Schema. */
function structuredOutputSchema(
  config: GenerateContentConfig,
): Record<string, unknown> | undefined {
  let schema: Record<string, unknown> | undefined;
  if (isSchemaLike(config.responseSchema)) {
    schema = toJsonSchema(config.responseSchema);
  } else if (isRecord(config.responseJsonSchema)) {
    schema = structuredClone(config.responseJsonSchema);
    lowercaseSchemaTypes(schema);
  }
  return schema && Object.keys(schema).length > 0 ? schema : undefined;
}

/** Derives the `json_schema` name OpenAI accepts from the schema's title. */
function schemaName(schema: Record<string, unknown>): string {
  const title = schema['title'];
  const name = typeof title === 'string' && title ? title : DEFAULT_SCHEMA_NAME;
  return name.replace(INVALID_SCHEMA_NAME_CHARS, () => '_');
}

/** Maps the ADK structured-output settings onto the Responses `text` field. */
export function responseTextConfig(
  config: GenerateContentConfig,
): ResponsesTextConfig | undefined {
  const schema = structuredOutputSchema(config);
  if (schema) {
    // The name is read before the strict transform, which strips every
    // sibling of a top-level `$ref` and would take the title with them.
    const name = schemaName(schema);
    enforceStrictOpenAiSchema(schema);
    return {format: {type: 'json_schema', name, strict: true, schema}};
  }
  if (config.responseMimeType === 'application/json') {
    return {format: {type: 'json_object'}};
  }
  return undefined;
}

/**
 * Maps the ADK thinking config onto a Responses reasoning config.
 *
 * Returns `undefined` when the request states no preference, which leaves the
 * model's own `reasoning` setting in force.
 *
 * @throws If a thinking config sets neither a level nor a budget, which would
 *   otherwise silently pick an effort the caller did not ask for.
 */
export function openAiReasoningConfig(
  config: GenerateContentConfig,
): OpenAIReasoningConfig | undefined {
  const thinkingConfig = config.thinkingConfig;
  if (!thinkingConfig) {
    return undefined;
  }
  const thinkingLevel = thinkingConfig.thinkingLevel;
  if (thinkingLevel) {
    const effort = thinkingLevel.toLowerCase();
    return reasoningConfig(
      effort === UNSPECIFIED_THINKING_LEVEL ? DEFAULT_REASONING_EFFORT : effort,
    );
  }
  const thinkingBudget = thinkingConfig.thinkingBudget;
  if (thinkingBudget === undefined || thinkingBudget === null) {
    throw new Error(THINKING_BUDGET_REQUIRED_MESSAGE);
  }
  // Responses reasoning is effort-based rather than budget-based: a zero
  // budget means minimal effort, and any other budget means medium.
  return reasoningConfig(
    thinkingBudget === 0 ? 'minimal' : DEFAULT_REASONING_EFFORT,
  );
}

function reasoningConfig(effort: string): OpenAIReasoningConfig {
  return {effort, summary: REASONING_SUMMARY};
}

/** Converts Responses token counts into ADK usage metadata. */
export function toUsageMetadata(
  usage?: OpenAIUsage | null,
): GenerateContentResponseUsageMetadata | undefined {
  if (!usage) {
    return undefined;
  }
  const promptTokenCount = optional(usage.input_tokens);
  const candidatesTokenCount = optional(usage.output_tokens);
  const totalTokenCount =
    optional(usage.total_tokens) ??
    (promptTokenCount !== undefined && candidatesTokenCount !== undefined
      ? promptTokenCount + candidatesTokenCount
      : undefined);
  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount,
    cachedContentTokenCount: optional(
      usage.input_tokens_details?.cached_tokens,
    ),
    thoughtsTokenCount: optional(usage.output_tokens_details?.reasoning_tokens),
  };
}

/** Maps the Responses response status onto an ADK finish reason. */
export function mapFinishReason(
  response: OpenAIResponse,
): FinishReason | undefined {
  switch (response.status) {
    case 'completed':
      return FinishReason.STOP;
    case 'incomplete': {
      const reason = response.incomplete_details?.reason;
      return reason === 'max_output_tokens' || reason === 'max_tokens'
        ? FinishReason.MAX_TOKENS
        : FinishReason.OTHER;
    }
    case 'failed':
    case 'cancelled':
      return FinishReason.OTHER;
    default:
      return undefined;
  }
}

/** Converts a `message` output item into ADK text parts. */
export function messageContentParts(item: OpenAIOutputItem): Part[] {
  const parts: Part[] = [];
  for (const content of item.content ?? []) {
    if (content.type === 'output_text' && content.text) {
      parts.push({text: content.text});
      continue;
    }
    if (content.type === 'refusal') {
      const refusal = content.refusal || content.text;
      if (refusal) {
        parts.push({text: REFUSAL_PREFIX + refusal});
      }
    }
  }
  return parts;
}

/**
 * Converts a `reasoning` output item into ADK thought parts and its metadata.
 *
 * An item that carries only encrypted content still produces one part, so the
 * signature survives into the next turn.
 */
export function reasoningItemParts(item: OpenAIOutputItem): {
  parts: Part[];
  metadata: Record<string, unknown>;
} {
  const parts: Part[] = [];
  const metadata: Record<string, unknown> = {};
  const encryptedContent = item.encrypted_content;
  const thoughtSignature = encryptedContent
    ? Buffer.from(encryptedContent, 'utf-8').toString('base64')
    : undefined;

  for (const entry of [...(item.summary ?? []), ...(item.content ?? [])]) {
    if (entry.text) {
      parts.push({text: entry.text, thought: true, thoughtSignature});
    }
  }
  if (encryptedContent) {
    metadata['encrypted_content'] = encryptedContent;
    if (parts.length === 0) {
      parts.push({thought: true, thoughtSignature});
    }
  }
  if (item.id) {
    metadata['id'] = item.id;
  }
  return {parts, metadata};
}

/** Converts a `function_call` output item into an ADK function-call part. */
export function functionCallPart(item: OpenAIOutputItem): Part {
  if (!item.name) {
    logger.warn('OpenAI Responses function call is missing a name.');
  }
  return {
    functionCall: {
      id: item.call_id || item.id || undefined,
      name: item.name ?? '',
      args: loadsJsonObject(item.arguments),
    },
  };
}

/** Assembles the raw payload ADK keeps on `customMetadata`. */
function responseCustomMetadata(
  response: OpenAIResponse,
  outputMetadata: OpenAIOutputItem[],
  reasoningMetadata: Array<Record<string, unknown>>,
  unmappedOutput: OpenAIOutputItem[],
): Record<string, unknown> {
  const openaiResponse: Record<string, unknown> = {
    id: response.id,
    status: response.status,
    output: outputMetadata,
  };
  if (response.usage) {
    openaiResponse['usage'] = response.usage;
  }
  if (reasoningMetadata.length > 0) {
    openaiResponse['reasoning'] = reasoningMetadata;
  }
  if (unmappedOutput.length > 0) {
    openaiResponse['unmapped_output'] = unmappedOutput;
  }
  return {openai_response: openaiResponse};
}

/** Converts a Responses API response into an ADK response. */
export function responseToLlmResponse(
  response: OpenAIResponse,
  options: ResponseConversionOptions,
): LlmResponse {
  const parts: Part[] = [];
  const outputMetadata: OpenAIOutputItem[] = [];
  const reasoningMetadata: Array<Record<string, unknown>> = [];
  const unmappedOutput: OpenAIOutputItem[] = [];

  for (const item of response.output ?? []) {
    switch (item.type) {
      case 'message':
        parts.push(...messageContentParts(item));
        break;
      case 'function_call':
        parts.push(functionCallPart(item));
        break;
      case 'reasoning': {
        const reasoning = reasoningItemParts(item);
        parts.push(...reasoning.parts);
        if (Object.keys(reasoning.metadata).length > 0) {
          reasoningMetadata.push(reasoning.metadata);
        }
        break;
      }
      default:
        unmappedOutput.push(item);
        break;
    }
    if (item.type) {
      outputMetadata.push(item);
    }
  }

  const finishReason = mapFinishReason(response);
  const llmResponse: LlmResponse = {
    content: parts.length > 0 ? {role: 'model', parts} : undefined,
    usageMetadata: toUsageMetadata(response.usage),
    finishReason,
    modelVersion: optional(response.model),
    interactionId: optional(response.id),
    customMetadata: options.includeResponseMetadata
      ? responseCustomMetadata(
          response,
          outputMetadata,
          reasoningMetadata,
          unmappedOutput,
        )
      : undefined,
  };
  if (finishReason && finishReason !== FinishReason.STOP) {
    const error = response.error ?? response.incomplete_details;
    llmResponse.errorCode = finishReason;
    llmResponse.errorMessage = error ? JSON.stringify(error) : undefined;
  }
  return llmResponse;
}

/** Applies the per-request generation config to the request body. */
function applyGenerateContentConfig(
  config: GenerateContentConfig,
  body: Record<string, unknown>,
): void {
  if (config.temperature !== undefined) {
    body['temperature'] = config.temperature;
  }
  if (config.topP !== undefined) {
    body['top_p'] = config.topP;
  }
  if (config.maxOutputTokens !== undefined) {
    body['max_output_tokens'] = config.maxOutputTokens;
  }
  if (config.stopSequences?.length) {
    body['stop'] = config.stopSequences;
  }
  const text = responseTextConfig(config);
  if (text) {
    body['text'] = text;
  }
  const reasoning = openAiReasoningConfig(config);
  if (reasoning) {
    body['reasoning'] = reasoning;
  }
  const tools = collectResponsesTools(config);
  if (tools.length > 0) {
    body['tools'] = tools;
  }
  const toolChoice = toolChoiceFromConfig(config);
  if (toolChoice) {
    body['tool_choice'] = toolChoice;
  }
}

/** Applies the model-level options, which the request config can override. */
function applyModelOptions(
  options: ResponsesRequestOptions,
  body: Record<string, unknown>,
): void {
  body['store'] = options.store;
  body['include'] = options.include;
  if (!('reasoning' in body)) {
    body['reasoning'] = options.reasoning;
  }
  body['parallel_tool_calls'] = options.parallelToolCalls;
  body['truncation'] = options.truncation;
  body['service_tier'] = options.serviceTier;
}

/**
 * Applies the caller's escape-hatch arguments, overriding computed fields.
 *
 * An `extra_body` entry is flattened into the body rather than sent as a
 * field. It is a request *option* of the Python SDK, which merges it into the
 * JSON; the Node SDK serializes the body verbatim, so a nested `extra_body`
 * would reach the API as an undefined request argument. Flattening it puts the
 * same keys on the wire as adk-python, and keeps the field name working for a
 * caller porting a Python configuration.
 */
function applyExtraRequestArgs(
  extraRequestArgs: Record<string, unknown> | undefined,
  body: Record<string, unknown>,
): void {
  const {extra_body: extraBody, ...topLevel} = {...extraRequestArgs};
  Object.assign(body, topLevel);
  if (isRecord(extraBody)) {
    Object.assign(body, extraBody);
  }
}

/**
 * Assembles the body of a `responses.create` call.
 *
 * Only absent values are dropped at the end: `stream: false`, `store: false`
 * and `temperature: 0` are all meaningful and have to survive.
 */
export function buildResponsesCreateParams(
  request: LlmRequest,
  options: ResponsesRequestOptions,
  stream: boolean,
): Record<string, unknown> {
  const config = request.config ?? {};
  const body: Record<string, unknown> = {
    model: request.model ?? options.model,
    input: toResponsesInput(request.contents),
    stream,
  };
  const instructions = extractSystemInstruction(config);
  if (instructions) {
    body['instructions'] = instructions;
  }
  if (request.previousInteractionId) {
    body['previous_response_id'] = request.previousInteractionId;
  }
  applyGenerateContentConfig(config, body);
  applyModelOptions(options, body);
  applyExtraRequestArgs(options.extraRequestArgs, body);
  return Object.fromEntries(
    Object.entries(body).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  );
}
