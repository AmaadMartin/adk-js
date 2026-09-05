/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  Part,
} from '@google/genai';

import {base64Decode} from '../utils/env_aware_utils.js';
import {
  audioFormatFromMimeType,
  guessMimeTypeFromFileName,
  inferMimeTypeFromUri,
  mediaKindFromMimeType,
  normalizeMimeType,
  UNKNOWN_MIME_TYPE,
} from '../utils/file_extension_utils.js';
import {genaiSchemaToJsonSchema} from '../utils/genai_schema_to_json.js';
import {
  isJsonObject,
  JsonObject,
  toJsonObject,
  toJsonText,
  toJsonValue,
} from '../utils/json_utils.js';
import {logger} from '../utils/logger.js';

import {extractSystemInstruction} from './interactions_utils.js';
import {
  getProviderFromModel,
  isAnthropicModel,
  isAnthropicRoute,
  isFileUriSupported,
  isGemma4Model,
  isHttpUrl,
  isLiteLlmGeminiModel,
  looksLikeOpenAiFileId,
  redactFileUriForLog,
  requiresFileId,
} from './lite_llm_model_utils.js';
import {
  ChatMessage,
  ContentObject,
  GenerationParams,
  MessageContent,
  MessageRole,
  ThinkingBlock,
  ToolCall,
  ToolChoice,
  ToolParam,
  ToolSpec,
} from './lite_llm_types.js';
import {LlmRequest} from './llm_request.js';

/**
 * Document MIME types that travel as a `file` block. `text/*` is decoded to
 * text instead, and media types get their own block, so neither appears here.
 */
const SUPPORTED_FILE_CONTENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/json',
  'application/x-sh',
]);

/** Response-format `type` values that are already a LiteLLM payload. */
const LITELLM_STRUCTURED_TYPES = new Set(['json_object', 'json_schema']);

/** The tool result inserted when a tool call was never answered. */
const MISSING_TOOL_RESULT_MESSAGE =
  'Error: Missing tool result (tool execution may have been interrupted ' +
  'before a response was recorded).';

/** The user text appended when a history has no usable user turn. */
const FALLBACK_USER_TEXT =
  'Handle the requests as specified in the System Instruction.';

/** Options that select provider-specific request shaping. */
export interface ProviderOptions {
  /** The provider name, for example `openai`. */
  provider: string;
  /** The full LiteLLM model string. */
  model: string;
}

/** Everything an `LlmRequest` contributes to a chat-completions request. */
export interface CompletionInputs {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  responseFormat?: JsonObject;
  generationParams?: GenerationParams;
  toolChoice?: ToolChoice;
}

/** Returns true when the part carries something the model can read. */
export function partHasPayload(part: Part): boolean {
  return Boolean(
    part.text ||
    part.inlineData?.data ||
    part.fileData?.fileUri ||
    part.functionResponse,
  );
}

/**
 * Appends a user text part when the history's last user turn carries no
 * payload, because OpenAI-compatible backends reject such a turn.
 *
 * Mutates `llmRequest.contents` in place.
 */
export function appendFallbackUserContentIfMissing(
  llmRequest: LlmRequest,
): void {
  for (let i = llmRequest.contents.length - 1; i >= 0; i--) {
    const content = llmRequest.contents[i];
    if (content.role !== 'user') {
      continue;
    }
    const parts = content.parts ?? [];
    if (parts.some(partHasPayload)) {
      return;
    }
    parts.push({text: FALLBACK_USER_TEXT});
    content.parts = parts;
    return;
  }
  llmRequest.contents.push({
    role: 'user',
    parts: [{text: FALLBACK_USER_TEXT}],
  });
}

/**
 * Joins thought parts into the single `reasoning_content` string a provider
 * expects.
 *
 * No separator is inserted: streaming providers emit reasoning as token-sized
 * chunks, so anything between them would change the model's own text.
 */
export function mergeReasoningTexts(parts: Part[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.text) {
      texts.push(part.text);
      continue;
    }
    const inlineData = part.inlineData;
    if (inlineData?.data && inlineData.mimeType?.startsWith('text/')) {
      texts.push(base64Decode(inlineData.data));
    }
  }
  return texts.join('');
}

/**
 * Rejoins the streaming fragments of an Anthropic thinking block.
 *
 * Anthropic splits one thinking block across many deltas: text-only chunks,
 * then a signature-only chunk at block stop. Text accumulates until a part
 * carries a signature, which flushes the accumulated text as one part under
 * that signature. Trailing text with no signature flushes as a final part.
 */
export function aggregateStreamingThoughtParts(parts: Part[]): Part[] {
  const aggregated: Part[] = [];
  let texts: string[] = [];
  for (const part of parts) {
    if (part.text) {
      texts.push(part.text);
    }
    if (part.thoughtSignature) {
      aggregated.push({
        text: texts.join(''),
        thought: true,
        thoughtSignature: part.thoughtSignature,
      });
      texts = [];
    }
  }
  if (texts.length > 0) {
    aggregated.push({text: texts.join(''), thought: true});
  }
  return aggregated;
}

/** Maps a genai content role onto a chat-completions role. */
export function toLiteLlmRole(role?: string): 'user' | 'assistant' {
  return role === 'model' || role === 'assistant' ? 'assistant' : 'user';
}

/**
 * Returns undefined for content that carries nothing.
 *
 * A string is always non-empty here: `getContent` only returns one for a part
 * that carries text.
 */
function emptyToUndefined(content: MessageContent): MessageContent | undefined {
  return typeof content === 'string' || content.length > 0
    ? content
    : undefined;
}

/** Builds the `file` block for a file URI the provider can resolve. */
function fileUriContentObject(
  fileUri: string,
  mimeType: string | undefined,
  displayName: string | undefined,
  options: ProviderOptions,
): ContentObject {
  if (!isFileUriSupported(options.provider, options.model, fileUri)) {
    throw new Error(
      `File URI \`${redactFileUriForLog(fileUri, displayName)}\` not supported` +
        ` for provider: ${options.provider}.`,
    );
  }
  if (!mimeType || mimeType === UNKNOWN_MIME_TYPE) {
    throw new Error(
      `Cannot process file_uri \`${redactFileUriForLog(fileUri, displayName)}\`:` +
        ` MIME type '${mimeType ?? '(unknown)'}' is not supported. Please set` +
        ' a specific MIME type on `file_data.mime_type`.',
    );
  }
  return {type: 'file', file: {file_id: fileUri, format: mimeType}};
}

/** Converts one `fileData` part into a content block. */
function fileDataContentObject(
  fileUri: string,
  declaredMimeType: string | undefined,
  displayName: string | undefined,
  options: ProviderOptions,
): ContentObject {
  if (requiresFileId(options.provider) && looksLikeOpenAiFileId(fileUri)) {
    return {type: 'file', file: {file_id: fileUri}};
  }

  let mimeType =
    declaredMimeType ??
    inferMimeTypeFromUri(fileUri) ??
    (displayName ? guessMimeTypeFromFileName(displayName) : undefined);
  if (mimeType) {
    mimeType = normalizeMimeType(mimeType);
  }

  // An HTTP media URL is a typed URL block for OpenAI and Azure. This runs
  // before the support check because those providers otherwise only accept an
  // uploaded file id.
  if (requiresFileId(options.provider) && isHttpUrl(fileUri) && mimeType) {
    switch (mediaKindFromMimeType(mimeType)) {
      case 'image':
        return {type: 'image_url', image_url: {url: fileUri}};
      case 'video':
        return {type: 'video_url', video_url: {url: fileUri}};
      default:
        break;
    }
  }

  return fileUriContentObject(fileUri, mimeType, displayName, options);
}

/** Converts one `inlineData` part into a content block. */
function inlineDataContentObject(
  data: string,
  mimeType: string,
  declaredMimeType: string,
): ContentObject {
  if (mimeType.startsWith('audio/')) {
    return {
      type: 'input_audio',
      input_audio: {data, format: audioFormatFromMimeType(mimeType)},
    };
  }
  const dataUri = `data:${mimeType};base64,${data}`;
  switch (mediaKindFromMimeType(mimeType)) {
    case 'image':
      return {type: 'image_url', image_url: {url: dataUri}};
    case 'video':
      return {type: 'video_url', video_url: {url: dataUri}};
    default:
      break;
  }
  if (SUPPORTED_FILE_CONTENT_MIME_TYPES.has(mimeType)) {
    return {type: 'file', file: {file_data: dataUri}};
  }
  throw new Error(
    'LiteLlm(BaseLlm) does not support content part with MIME type ' +
      `${declaredMimeType}.`,
  );
}

/**
 * Converts genai parts into a chat-completions message content.
 *
 * Callers filter out thought parts first when the provider must not see them.
 *
 * @throws When a part carries a MIME type or a file URI the provider cannot
 *     accept.
 */
export function getContent(
  parts: Part[],
  options: ProviderOptions,
): MessageContent {
  if (parts.length === 1) {
    const part = parts[0];
    if (part.text) {
      return part.text;
    }
    const inlineData = part.inlineData;
    if (
      inlineData?.data &&
      inlineData.mimeType &&
      normalizeMimeType(inlineData.mimeType).startsWith('text/')
    ) {
      return base64Decode(inlineData.data);
    }
  }

  const contentObjects: ContentObject[] = [];
  for (const part of parts) {
    if (part.text) {
      contentObjects.push({type: 'text', text: part.text});
      continue;
    }
    const inlineData = part.inlineData;
    if (inlineData?.data && inlineData.mimeType) {
      const mimeType = normalizeMimeType(inlineData.mimeType);
      if (mimeType.startsWith('text/')) {
        contentObjects.push({
          type: 'text',
          text: base64Decode(inlineData.data),
        });
        continue;
      }
      contentObjects.push(
        inlineDataContentObject(inlineData.data, mimeType, inlineData.mimeType),
      );
      continue;
    }
    const fileData = part.fileData;
    if (fileData?.fileUri) {
      contentObjects.push(
        fileDataContentObject(
          fileData.fileUri,
          fileData.mimeType,
          fileData.displayName,
          options,
        ),
      );
    }
  }
  return contentObjects;
}

/** Converts media a tool attached to its response into content parts. */
function functionResponseMediaParts(part: Part): Part[] {
  const mediaParts: Part[] = [];
  for (const responsePart of part.functionResponse?.parts ?? []) {
    const blob = responsePart.inlineData;
    if (!blob?.data || !blob.mimeType) {
      continue;
    }
    mediaParts.push({inlineData: {data: blob.data, mimeType: blob.mimeType}});
  }
  return mediaParts;
}

/** Builds the `tool_calls` of an assistant message from its parts. */
function toToolCalls(parts: Part[]): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  for (const part of parts) {
    const functionCall = part.functionCall;
    if (!functionCall) {
      continue;
    }
    if (!functionCall.name) {
      throw new Error('LiteLLM function calls require a name');
    }
    const toolCall: ToolCall = {
      type: 'function',
      id: functionCall.id ?? '',
      function: {
        name: functionCall.name,
        arguments: toJsonText(functionCall.args),
      },
    };
    // LiteLLM's Gemini prompt conversion reads provider_specific_fields, while
    // the OpenAI-compatible Gemini endpoint reads extra_content. Sending both
    // keeps a thinking model's reasoning chain intact on either path.
    // See https://ai.google.dev/gemini-api/docs/thought-signatures.
    const signature = part.thoughtSignature;
    if (signature) {
      toolCall.provider_specific_fields = {thought_signature: signature};
      toolCall.extra_content = {google: {thought_signature: signature}};
    }
    toolCalls.push(toolCall);
  }
  return toolCalls;
}

/** Builds the assistant message for a model turn. */
function assistantMessage(
  parts: Part[],
  options: ProviderOptions,
): ChatMessage {
  const reasoningParts = parts.filter(
    (part) => !part.functionCall && part.thought,
  );
  const contentParts = parts.filter(
    (part) => !part.functionCall && !part.thought,
  );

  const toolCalls = toToolCalls(parts);
  let content =
    contentParts.length > 0
      ? emptyToUndefined(getContent(contentParts, options))
      : undefined;
  // A single text block is sent as a bare string: ollama_chat rejects a list.
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    content[0].type === 'text'
  ) {
    content = content[0].text;
  }
  const toolCallsField = toolCalls.length > 0 ? toolCalls : undefined;

  // A Claude model takes its thinking as a top-level array. Only a block with
  // both text and a signature survives Anthropic's multi-turn validation.
  if (options.model && isAnthropicModel(options.model)) {
    const thinkingBlocks: ThinkingBlock[] = [];
    for (const part of aggregateStreamingThoughtParts(reasoningParts)) {
      if (part.text && part.thoughtSignature) {
        thinkingBlocks.push({
          type: 'thinking',
          thinking: part.text,
          signature: part.thoughtSignature,
        });
      }
    }
    if (thinkingBlocks.length > 0) {
      return {
        role: 'assistant',
        content: content ?? null,
        tool_calls: toolCallsField,
        thinking_blocks: thinkingBlocks,
      };
    }
  }

  // Any route that reaches Claude takes its thinking as leading content
  // blocks: LiteLLM's Anthropic template drops the top-level reasoning field,
  // so thinking would vanish from a multi-turn history.
  if (
    reasoningParts.length > 0 &&
    isAnthropicRoute(options.provider, options.model)
  ) {
    const blocks: ContentObject[] = [];
    for (const part of reasoningParts) {
      if (!part.text) {
        continue;
      }
      const block: ThinkingBlock = {type: 'thinking', thinking: part.text};
      if (part.thoughtSignature) {
        block.signature = part.thoughtSignature;
      }
      blocks.push(block);
    }
    if (Array.isArray(content)) {
      blocks.push(...content);
    } else if (content) {
      blocks.push({type: 'text', text: content});
    }
    return {
      role: 'assistant',
      content: blocks.length > 0 ? blocks : null,
      tool_calls: toolCallsField,
    };
  }

  const reasoningContent = mergeReasoningTexts(reasoningParts);

  return {
    role: 'assistant',
    content: content ?? null,
    tool_calls: toolCallsField,
    reasoning_content: reasoningContent || undefined,
  };
}

/**
 * Returns the role a tool result must carry to reach this model.
 *
 * Gemma 4's chat template only recognises `tool_responses`. Under the
 * OpenAI-compatible `tool` role it does not see the result, and re-issues the
 * same tool call.
 */
export function toolResultRole(model: string): MessageRole {
  return isGemma4Model(model) ? 'tool_responses' : 'tool';
}

/**
 * Converts one genai `Content` into the chat message or messages it becomes.
 *
 * A turn carrying function responses becomes one tool-result message per
 * response, followed by any remaining parts as their own message.
 *
 * @returns The messages, or undefined when the content has no parts.
 */
export function contentToMessageParam(
  content: Content,
  options: ProviderOptions,
): ChatMessage | ChatMessage[] | undefined {
  const parts = content.parts ?? [];
  if (parts.length === 0) {
    return undefined;
  }

  const toolRole = toolResultRole(options.model);
  const toolMessages: ChatMessage[] = [];
  const nonToolParts: Part[] = [];
  for (const part of parts) {
    const functionResponse = part.functionResponse;
    if (!functionResponse) {
      nonToolParts.push(part);
      continue;
    }
    toolMessages.push({
      role: toolRole,
      tool_call_id: functionResponse.id ?? '',
      content: toJsonText(functionResponse.response),
    });
    // A tool message carries text only, so attached media follows it as its
    // own message.
    nonToolParts.push(...functionResponseMediaParts(part));
  }

  if (toolMessages.length === 0) {
    return turnMessage(content.role, parts, options);
  }
  if (nonToolParts.length === 0) {
    return toolMessages.length > 1 ? toolMessages : toolMessages[0];
  }
  return [...toolMessages, turnMessage(content.role, nonToolParts, options)];
}

/** Builds the message for a user or assistant turn. */
function turnMessage(
  role: string | undefined,
  parts: Part[],
  options: ProviderOptions,
): ChatMessage {
  if (toLiteLlmRole(role) === 'assistant') {
    return assistantMessage(parts, options);
  }
  const userParts = parts.filter((part) => !part.thought);
  return {
    role: 'user',
    content: emptyToUndefined(getContent(userParts, options)) ?? null,
  };
}

/**
 * Inserts a placeholder tool result for every tool call the history left
 * unanswered, because providers reject such a history outright.
 *
 * The placeholders carry the role this model reads tool results under, so a
 * Gemma 4 history is not healed with messages the model then ignores.
 */
export function ensureToolResults(
  messages: ChatMessage[],
  model: string,
): ChatMessage[] {
  const toolRole = toolResultRole(model);
  const healed: ChatMessage[] = [];
  let pendingToolCallIds: string[] = [];

  const flushPending = () => {
    logger.warn(
      `Missing tool results for tool_call_id(s): ${pendingToolCallIds.join(', ')}`,
    );
    for (const toolCallId of pendingToolCallIds) {
      healed.push({
        role: toolRole,
        tool_call_id: toolCallId,
        content: MISSING_TOOL_RESULT_MESSAGE,
      });
    }
    pendingToolCallIds = [];
  };

  for (const message of messages) {
    if (pendingToolCallIds.length > 0 && message.role !== toolRole) {
      flushPending();
    }
    if (message.role === 'assistant') {
      pendingToolCallIds = (message.tool_calls ?? [])
        .map((toolCall) => toolCall.id)
        .filter((id): id is string => Boolean(id));
    } else if (message.role === toolRole) {
      pendingToolCallIds = pendingToolCallIds.filter(
        (id) => id !== message.tool_call_id,
      );
    }
    healed.push(message);
  }

  if (pendingToolCallIds.length > 0) {
    flushPending();
  }
  return healed;
}

/** Converts a genai function declaration into a chat-completions tool. */
export function functionDeclarationToToolParam(
  functionDeclaration: FunctionDeclaration,
): ToolParam {
  let parameters: JsonObject = {type: 'object', properties: {}};
  const declaredProperties = functionDeclaration.parameters?.properties;
  if (declaredProperties) {
    const properties: JsonObject = {};
    for (const [key, value] of Object.entries(declaredProperties)) {
      properties[key] = toJsonObject(genaiSchemaToJsonSchema(value));
    }
    parameters = {type: 'object', properties};
  } else {
    const jsonSchema = toJsonValue(functionDeclaration.parametersJsonSchema);
    if (isJsonObject(jsonSchema) && Object.keys(jsonSchema).length > 0) {
      parameters = jsonSchema;
    }
  }

  const required = functionDeclaration.parameters?.required;
  if (required?.length) {
    parameters['required'] = [...required];
  }

  return {
    type: 'function',
    function: {
      name: functionDeclaration.name ?? '',
      description: functionDeclaration.description ?? '',
      parameters,
    },
  };
}

/**
 * Rewrites a JSON schema in place for OpenAI strict structured outputs: every
 * object forbids extra properties and lists all of them as required, and a
 * `$ref` keeps no sibling keywords.
 */
export function enforceStrictOpenAiSchema(schema: JsonObject): void {
  if ('$ref' in schema) {
    for (const key of Object.keys(schema)) {
      if (key !== '$ref') {
        delete schema[key];
      }
    }
    return;
  }

  const properties = schema['properties'];
  if (schema['type'] === 'object' && isJsonObject(properties)) {
    schema['additionalProperties'] = false;
    schema['required'] = Object.keys(properties).sort();
  }

  const defs = schema['$defs'];
  if (isJsonObject(defs)) {
    for (const value of Object.values(defs)) {
      if (isJsonObject(value)) {
        enforceStrictOpenAiSchema(value);
      }
    }
  }
  if (isJsonObject(properties)) {
    for (const value of Object.values(properties)) {
      if (isJsonObject(value)) {
        enforceStrictOpenAiSchema(value);
      }
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        if (isJsonObject(branch)) {
          enforceStrictOpenAiSchema(branch);
        }
      }
    }
  }
  const items = schema['items'];
  if (isJsonObject(items)) {
    enforceStrictOpenAiSchema(items);
  }
}

/**
 * Converts an ADK response schema into the `response_format` the model wants.
 *
 * Gemini models take the schema under `response_schema`; everything else takes
 * an OpenAI strict `json_schema`. The input is never mutated.
 *
 * @returns The response format, or undefined when the schema is unsupported.
 */
export function toLiteLlmResponseFormat(
  responseSchema: unknown,
  model: string,
): JsonObject | undefined {
  const schema = toJsonValue(responseSchema);
  if (!isJsonObject(schema)) {
    logger.warn(
      'Unsupported response_schema for LiteLLM structured outputs; the' +
        ' response format was dropped.',
    );
    return undefined;
  }

  const type = schema['type'];
  if (
    typeof type === 'string' &&
    LITELLM_STRUCTURED_TYPES.has(type.toLowerCase())
  ) {
    return schema;
  }

  const title = schema['title'];
  const schemaName = typeof title === 'string' ? title : 'response';
  // An agent's `outputSchema` arrives as a genai Schema, whose uppercase type
  // names and stringified bounds no provider understands. A schema already
  // written as plain JSON Schema is left alone.
  const jsonSchema = isGenaiDialect(schema)
    ? toJsonObject(genaiSchemaToJsonSchema(schema))
    : schema;

  if (isLiteLlmGeminiModel(model)) {
    return {type: 'json_object', response_schema: jsonSchema};
  }

  enforceStrictOpenAiSchema(jsonSchema);
  return {
    type: 'json_schema',
    json_schema: {name: schemaName, strict: true, schema: jsonSchema},
  };
}

/**
 * Returns true when a schema is written in the genai dialect rather than in
 * plain JSON Schema. genai spells its type names in uppercase.
 */
function isGenaiDialect(schema: JsonObject): boolean {
  const type = schema['type'];
  return typeof type === 'string' && type === type.toUpperCase();
}

/** Replaces the payload of a part with something safe to log. */
function redactPartForLog(part: Part): Part {
  if (part.inlineData?.data) {
    return {...part, inlineData: {...part.inlineData, data: '<redacted>'}};
  }
  if (part.fileData?.fileUri) {
    return {
      ...part,
      fileData: {
        ...part.fileData,
        fileUri: redactFileUriForLog(
          part.fileData.fileUri,
          part.fileData.displayName,
        ),
      },
    };
  }
  return part;
}

/** Renders one function declaration for the request log. */
function buildFunctionDeclarationLog(
  functionDeclaration: FunctionDeclaration,
): string {
  const properties = functionDeclaration.parameters?.properties;
  const parameters = properties ? JSON.stringify(properties) : '{}';
  const response = functionDeclaration.response
    ? JSON.stringify(functionDeclaration.response)
    : 'none';
  return `${functionDeclaration.name}: ${parameters} -> ${response}`;
}

/**
 * Renders a request for the debug log.
 *
 * Inline data and file URIs are redacted: a request carries user data and
 * signed URLs, and a debug log is frequently attached to a bug report.
 */
export function buildRequestLog(llmRequest: LlmRequest): string {
  const config = llmRequest.config ?? {};
  const contents = llmRequest.contents
    .map((content) =>
      JSON.stringify({...content, parts: content.parts?.map(redactPartForLog)}),
    )
    .join('\n');
  const functions = (config.tools ?? [])
    .flatMap((tool) =>
      'callTool' in tool ? [] : (tool.functionDeclarations ?? []),
    )
    .map(buildFunctionDeclarationLog)
    .join('\n');

  return [
    'LiteLlm request:',
    `System Instruction: ${extractSystemInstruction(config) ?? ''}`,
    `Contents:\n${contents}`,
    `Functions:\n${functions}`,
  ].join('\n');
}

/** Reads the generation parameters the wire protocol understands. */
function toGenerationParams(
  llmRequest: LlmRequest,
): GenerationParams | undefined {
  const config = llmRequest.config;
  if (!config) {
    return undefined;
  }
  const params: GenerationParams = {};
  if (config.temperature !== undefined) {
    params.temperature = config.temperature;
  }
  if (config.maxOutputTokens !== undefined) {
    params.max_completion_tokens = config.maxOutputTokens;
  }
  if (config.topP !== undefined) {
    params.top_p = config.topP;
  }
  if (config.topK !== undefined) {
    params.top_k = config.topK;
  }
  if (config.stopSequences !== undefined) {
    params.stop = config.stopSequences;
  }
  if (config.presencePenalty !== undefined) {
    params.presence_penalty = config.presencePenalty;
  }
  if (config.frequencyPenalty !== undefined) {
    params.frequency_penalty = config.frequencyPenalty;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/** Reads the tool declarations the wire protocol understands. */
function toToolSpecs(llmRequest: LlmRequest): ToolSpec[] | undefined {
  const declaredTools = llmRequest.config?.tools;
  if (!declaredTools) {
    return undefined;
  }
  const tools: ToolSpec[] = [];
  for (const tool of declaredTools) {
    if ('callTool' in tool) {
      continue;
    }
    if (tool.functionDeclarations) {
      for (const functionDeclaration of tool.functionDeclarations) {
        tools.push(functionDeclarationToToolParam(functionDeclaration));
      }
      continue;
    }
    // A native tool such as google search carries no function declarations;
    // forward it verbatim rather than dropping it.
    const serialized = toJsonValue(tool);
    if (isJsonObject(serialized) && Object.keys(serialized).length > 0) {
      tools.push(serialized);
    }
  }
  return tools.length > 0 ? tools : undefined;
}

/** Reads the `tool_choice` the request's tool config asks for. */
function toToolChoice(llmRequest: LlmRequest): ToolChoice | undefined {
  const mode = llmRequest.config?.toolConfig?.functionCallingConfig?.mode;
  if (mode === FunctionCallingConfigMode.ANY) {
    return 'required';
  }
  if (mode === FunctionCallingConfigMode.NONE) {
    return 'none';
  }
  return undefined;
}

/** Converts an `LlmRequest` into everything the chat-completions call needs. */
export function getCompletionInputs(
  llmRequest: LlmRequest,
  model: string,
): CompletionInputs {
  const options: ProviderOptions = {
    provider: getProviderFromModel(model),
    model,
  };

  const messages: ChatMessage[] = [];
  for (const content of llmRequest.contents) {
    const converted = contentToMessageParam(content, options);
    if (Array.isArray(converted)) {
      messages.push(...converted);
    } else if (converted) {
      messages.push(converted);
    }
  }

  const systemInstruction = extractSystemInstruction(llmRequest.config ?? {});
  if (systemInstruction) {
    messages.unshift({role: 'system', content: systemInstruction});
  }

  const tools = toToolSpecs(llmRequest);
  const responseSchema = llmRequest.config?.responseSchema;

  return {
    messages: ensureToolResults(messages, model),
    tools,
    responseFormat:
      responseSchema === undefined
        ? undefined
        : toLiteLlmResponseFormat(responseSchema, model),
    generationParams: toGenerationParams(llmRequest),
    // Providers reject a tool choice when there is nothing to choose from.
    toolChoice: tools ? toToolChoice(llmRequest) : undefined,
  };
}
