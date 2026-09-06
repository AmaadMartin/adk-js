/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts ADK request objects into OpenAI Responses API request fields.
 *
 * Ports the request half of adk-python
 * `src/google/adk/labs/openai/_openai_responses_llm.py`.
 */

import {
  Content,
  ContentUnion,
  FileData,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  FunctionResponse,
  Blob as GenaiBlob,
  GenerateContentConfig,
  Part,
  PartUnion,
  ThinkingLevel,
} from '@google/genai';
import type OpenAI from 'openai';

import {logger} from '../../utils/logger.js';
import {toJsonSchema} from '../../utils/schema.js';
import {isZodSchema} from '../../utils/simple_zod_to_json.js';

import {
  enforceStrictOpenAiSchema,
  isJsonObject,
  lowercaseSchemaTypes,
} from './openai_schema.js';

/** A role the Responses API accepts on an input message. */
type ResponsesRole = OpenAI.Responses.EasyInputMessage['role'];

/** Reasoning effort for each genai thinking level. */
const THINKING_LEVEL_EFFORT: Record<ThinkingLevel, OpenAI.ReasoningEffort> = {
  [ThinkingLevel.THINKING_LEVEL_UNSPECIFIED]: 'medium',
  [ThinkingLevel.MINIMAL]: 'minimal',
  [ThinkingLevel.LOW]: 'low',
  [ThinkingLevel.MEDIUM]: 'medium',
  [ThinkingLevel.HIGH]: 'high',
};

/** Responses `tool_choice` for each genai function-calling mode. */
const TOOL_CHOICE_BY_MODE: Partial<
  Record<FunctionCallingConfigMode, OpenAI.Responses.ToolChoiceOptions>
> = {
  [FunctionCallingConfigMode.ANY]: 'required',
  [FunctionCallingConfigMode.NONE]: 'none',
  [FunctionCallingConfigMode.AUTO]: 'auto',
};

/** OpenAI requires a `json_schema` format name to match this pattern. */
const VALID_CALL_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Maps invalid or missing function call IDs onto IDs the Responses API
 * accepts.
 *
 * One sanitizer serves one request, so a call and its result are given the
 * same fallback ID and still pair up, while an absent ID always gets a fresh
 * one.
 */
export class CallIdSanitizer {
  private readonly mapping = new Map<string, string>();
  private nextFallback = 0;

  sanitize(callId: string | undefined): string {
    if (callId && VALID_CALL_ID.test(callId)) {
      return callId;
    }
    if (!callId) {
      return this.newFallback();
    }
    const known = this.mapping.get(callId);
    if (known !== undefined) {
      return known;
    }
    const fallback = this.newFallback();
    this.mapping.set(callId, fallback);
    return fallback;
  }

  private newFallback(): string {
    return `call_adk_fallback_${this.nextFallback++}`;
  }
}

/** Returns a Part's text, or the empty string when it has none. */
function partText(part: Part): string {
  return part.text ?? '';
}

/** Returns the text of one system-instruction element. */
function instructionElementText(element: PartUnion): string {
  return typeof element === 'string' ? element : partText(element);
}

/**
 * Serializes an ADK system instruction into the Responses `instructions`
 * string.
 *
 * The parts of a `Content` are joined without a separator, matching the
 * reference implementation. `extractSystemInstruction` in
 * `models/interactions_utils.ts` joins with a newline instead, so reusing it
 * here would change the bytes sent to OpenAI.
 */
export function serializeSystemInstruction(
  systemInstruction: ContentUnion | undefined,
): string | undefined {
  if (!systemInstruction) {
    return undefined;
  }
  if (typeof systemInstruction === 'string') {
    return systemInstruction;
  }
  if (Array.isArray(systemInstruction)) {
    return systemInstruction.map(instructionElementText).join('');
  }
  if (isContent(systemInstruction)) {
    return (systemInstruction.parts ?? []).map(partText).join('');
  }
  return partText(systemInstruction);
}

/** Returns true when a `ContentUnion` element is a `Content` and not a `Part`. */
function isContent(value: Content | Part): value is Content {
  return 'parts' in value || 'role' in value;
}

/**
 * Returns a deep JSON copy of a schema with every nested `type` lowercased.
 *
 * A genai `Schema` spells its type as the uppercase enum name; a plain JSON
 * Schema object is already lowercase and passes through unchanged. A Zod type
 * is rendered to JSON Schema first.
 */
export function schemaToJsonObject(schema: unknown): Record<string, unknown> {
  if (isZodSchema(schema)) {
    return toJsonSchema(schema);
  }
  if (!isJsonObject(schema)) {
    return {};
  }
  const parsed: unknown = JSON.parse(JSON.stringify(schema));
  if (!isJsonObject(parsed)) {
    return {};
  }
  lowercaseSchemaTypes(parsed);
  return parsed;
}

/**
 * Maps the ADK structured-output settings onto the Responses `text` field.
 *
 * @return The `text` field, or `undefined` when the request asks for no
 *   particular output format.
 */
export function responseTextConfig(
  config: GenerateContentConfig,
): OpenAI.Responses.ResponseTextConfig | undefined {
  const schema = config.responseSchema ?? config.responseJsonSchema;
  if (schema !== undefined && schema !== null) {
    const schemaObject = schemaToJsonObject(schema);
    if (Object.keys(schemaObject).length === 0) {
      return undefined;
    }
    enforceStrictOpenAiSchema(schemaObject);
    return {
      format: {
        type: 'json_schema',
        name: schemaFormatName(schemaObject),
        strict: true,
        schema: schemaObject,
      },
    };
  }
  if (config.responseMimeType === 'application/json') {
    return {format: {type: 'json_object'}};
  }
  return undefined;
}

/**
 * Returns the `json_schema` format name for a schema.
 *
 * OpenAI requires the name to match `^[a-zA-Z0-9_-]+$`, so every other
 * character in the schema's title becomes an underscore.
 */
function schemaFormatName(schemaObject: Record<string, unknown>): string {
  const title = schemaObject['title'];
  if (typeof title !== 'string') {
    return 'schema';
  }
  return title.replace(/[^a-zA-Z0-9_-]/g, '_') || 'schema';
}

/** Returns the Responses reasoning config for an effort level. */
function reasoningFor(effort: OpenAI.ReasoningEffort): OpenAI.Reasoning {
  return {effort, summary: 'concise'};
}

/**
 * Maps an ADK thinking config onto the Responses `reasoning` field.
 *
 * @return The reasoning config, or `undefined` when the request carries no
 *   thinking config and the model's own `reasoning` option should apply.
 * @throws If a thinking config sets neither a level nor a budget, which leaves
 *   the intended reasoning effort undefined.
 */
export function openAiReasoningConfig(
  config: GenerateContentConfig,
): OpenAI.Reasoning | undefined {
  const thinkingConfig = config.thinkingConfig;
  if (!thinkingConfig) {
    return undefined;
  }
  if (thinkingConfig.thinkingLevel) {
    return reasoningFor(THINKING_LEVEL_EFFORT[thinkingConfig.thinkingLevel]);
  }
  const thinkingBudget = thinkingConfig.thinkingBudget;
  if (thinkingBudget === undefined) {
    throw new Error(
      'thinking_budget must be set explicitly when ThinkingConfig is' +
        ' provided without thinking_level for OpenAI Responses models. Use' +
        ' thinking_level for effort-based reasoning, 0 for minimal reasoning,' +
        ' or -1 for medium reasoning.',
    );
  }
  // Responses reasoning is effort-based rather than token-budget based: a zero
  // budget maps to minimal effort, any other budget to medium.
  return reasoningFor(thinkingBudget === 0 ? 'minimal' : 'medium');
}

/** Maps the ADK function-calling mode onto the Responses `tool_choice`. */
export function toolChoice(
  config: GenerateContentConfig,
): OpenAI.Responses.ToolChoiceOptions | undefined {
  const mode = config.toolConfig?.functionCallingConfig?.mode;
  return mode ? TOOL_CHOICE_BY_MODE[mode] : undefined;
}

/**
 * Converts an ADK function declaration into a Responses function tool.
 *
 * @throws If the declaration has no name, which the Responses API requires.
 */
export function functionDeclarationToResponseTool(
  functionDeclaration: FunctionDeclaration,
): OpenAI.Responses.FunctionTool {
  if (!functionDeclaration.name) {
    throw new Error('FunctionDeclaration must have a name.');
  }

  const jsonSchema = functionDeclaration.parametersJsonSchema;
  const declaredParameters = functionDeclaration.parameters;
  let parameters: Record<string, unknown>;
  if (jsonSchema !== undefined && jsonSchema !== null) {
    parameters = schemaToJsonObject(jsonSchema);
  } else if (declaredParameters) {
    parameters = schemaToJsonObject(declaredParameters);
  } else {
    parameters = {type: 'object', properties: {}};
  }

  const required =
    jsonSchema === undefined || jsonSchema === null
      ? declaredParameters?.required
      : undefined;
  if (required?.length && !('required' in parameters)) {
    parameters['required'] = required;
  }

  return {
    type: 'function',
    name: functionDeclaration.name,
    description: functionDeclaration.description ?? '',
    parameters,
    strict: false,
  };
}

/**
 * Serializes a tool result into the string the Responses API expects as a
 * `function_call_output`.
 *
 * A Model Context Protocol tool answers with a `content` list of typed blocks,
 * so those are flattened to their text; everything else is JSON.
 */
export function serializeToolOutput(
  response: Record<string, unknown> | undefined,
): string {
  if (!response) {
    return '';
  }
  const content = response['content'];
  if (Array.isArray(content) && content.length > 0) {
    return content.map(contentBlockToText).join('\n');
  }
  if (typeof content === 'string' && content) {
    return content;
  }
  const result = response['result'];
  if (result !== undefined && result !== null) {
    return typeof result === 'string' ? result : JSON.stringify(result);
  }
  return JSON.stringify(response);
}

/** Returns the text of one Model Context Protocol content block. */
function contentBlockToText(block: unknown): string {
  if (isJsonObject(block) && block['type'] === 'text' && 'text' in block) {
    return String(block['text']);
  }
  return typeof block === 'string' ? block : JSON.stringify(block);
}

/** Maps an ADK content role onto a Responses input role. */
function toResponsesRole(role: string | undefined): ResponsesRole {
  switch (role) {
    case 'model':
    case 'assistant':
      return 'assistant';
    case 'system':
    case 'developer':
      return role;
    default:
      return 'user';
  }
}

/** Converts inline data into Responses input content. */
function inlineDataToInputContent(
  inlineData: GenaiBlob,
): OpenAI.Responses.ResponseInputContent {
  const mimeType = inlineData.mimeType || 'application/octet-stream';
  // `Blob.data` is already base64 in @google/genai, where the reference
  // implementation holds raw bytes and encodes them here.
  const dataUrl = `data:${mimeType};base64,${inlineData.data ?? ''}`;
  switch (mimeType.split('/')[0]) {
    case 'image':
      return {type: 'input_image', detail: 'auto', image_url: dataUrl};
    default:
      return {
        type: 'input_file',
        filename: inlineData.displayName || 'inline_data',
        file_data: dataUrl,
      };
  }
}

/** Converts file data into Responses input content. */
function fileDataToInputContent(
  fileData: FileData,
): OpenAI.Responses.ResponseInputContent {
  const fileUri = fileData.fileUri ?? '';
  const mimeType = fileData.mimeType ?? '';
  switch (mimeType.split('/')[0]) {
    case 'image':
      return {type: 'input_image', detail: 'auto', image_url: fileUri};
    default:
      return fileUri.startsWith('file-')
        ? {type: 'input_file', file_id: fileUri}
        : {type: 'input_file', file_url: fileUri};
  }
}

/**
 * Renders an executable-code or code-result part as text.
 *
 * @return The rendered text, or `undefined` for any other part.
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
 * Reports that a replayed thought was dropped from the request.
 *
 * A Responses reasoning input item must reference a reasoning item ID from a
 * real prior response. ADK thought parts do not carry those IDs and the API
 * rejects synthetic ones, so continuity runs through `previous_response_id`
 * instead.
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

/**
 * Accumulates the input items produced by one ADK `Content`.
 *
 * Message content builds up across consecutive parts and is flushed into a
 * single message item whenever an item that must keep its position arrives —
 * a function call, a function result, or a standalone assistant message.
 */
class InputItemBuilder {
  private readonly items: OpenAI.Responses.ResponseInputItem[] = [];
  private readonly messageParts: OpenAI.Responses.ResponseInputContent[] = [];

  constructor(private readonly role: ResponsesRole) {}

  addContent(content: OpenAI.Responses.ResponseInputContent): void {
    this.messageParts.push(content);
  }

  addItem(item: OpenAI.Responses.ResponseInputItem): void {
    this.flushMessage();
    this.items.push(item);
  }

  addAssistantText(text: string): void {
    this.addItem({type: 'message', role: 'assistant', content: text});
  }

  build(): OpenAI.Responses.ResponseInputItem[] {
    this.flushMessage();
    return this.items;
  }

  /** Emits the message accumulated so far, if any, keeping later parts apart. */
  flushMessage(): void {
    if (this.messageParts.length === 0) {
      return;
    }
    this.items.push({
      type: 'message',
      role: this.role,
      content: [...this.messageParts],
    });
    this.messageParts.length = 0;
  }
}

/** Adds a function-response part to the builder. */
function addFunctionResponse(
  builder: InputItemBuilder,
  functionResponse: FunctionResponse,
  sanitizer: CallIdSanitizer,
): void {
  builder.addItem({
    type: 'function_call_output',
    call_id: sanitizer.sanitize(functionResponse.id),
    output: serializeToolOutput(functionResponse.response),
  });
}

/**
 * Adds media content to the builder.
 *
 * A Responses assistant turn takes no media, so it is dropped with a warning
 * rather than sent as an input block the API rejects.
 */
function addMedia(
  builder: InputItemBuilder,
  role: ResponsesRole,
  content: OpenAI.Responses.ResponseInputContent,
): void {
  if (role === 'assistant') {
    logger.warn('Media data is not supported in Responses assistant turns.');
    return;
  }
  builder.addContent(content);
}

/** Adds a text part to the builder, honouring the turn's role. */
function addText(
  builder: InputItemBuilder,
  text: string,
  role: ResponsesRole,
): void {
  if (role === 'assistant') {
    builder.addAssistantText(text);
  } else {
    builder.addContent({type: 'input_text', text});
  }
}

/**
 * Converts one ADK `Content` into Responses API input items.
 *
 * @param content The content to convert.
 * @param sanitizer Shared across a whole request, so a function call and its
 *   result agree on a substituted call ID.
 */
export function contentToResponseInputItems(
  content: Content,
  sanitizer: CallIdSanitizer = new CallIdSanitizer(),
): OpenAI.Responses.ResponseInputItem[] {
  const role = toResponsesRole(content.role);
  const builder = new InputItemBuilder(role);

  for (const part of content.parts ?? []) {
    if (part.functionResponse) {
      addFunctionResponse(builder, part.functionResponse, sanitizer);
    } else if (part.functionCall) {
      builder.addItem({
        type: 'function_call',
        call_id: sanitizer.sanitize(part.functionCall.id),
        name: part.functionCall.name ?? '',
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    } else if (part.thought && (part.text || part.thoughtSignature)) {
      builder.flushMessage();
      logSkippedReasoningPart(part);
    } else if (part.text) {
      addText(builder, part.text, role);
    } else if (part.inlineData) {
      addMedia(builder, role, inlineDataToInputContent(part.inlineData));
    } else if (part.fileData) {
      addMedia(builder, role, fileDataToInputContent(part.fileData));
    } else {
      const text = codePartToText(part);
      if (text) {
        addText(builder, text, role);
      }
    }
  }

  return builder.build();
}
