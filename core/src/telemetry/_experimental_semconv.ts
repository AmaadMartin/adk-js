/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Instrumentation for the experimental OpenTelemetry GenAI semantic
 * conventions:
 * https://github.com/open-telemetry/semantic-conventions/blob/v1.39.0/docs/gen-ai/gen-ai-events.md
 *
 * Ported from adk-python `src/google/adk/telemetry/_experimental_semconv.py`,
 * and organized in the same sections:
 *
 *   * Section A — constants and the shapes emitted on the wire.
 *   * Section B — pure builders. None of them mutate their arguments.
 *   * Section C — the attribute setters and the log-emission entry point,
 *     which write into caller-supplied maps.
 *
 * Nothing here throws. A value that cannot be represented degrades to
 * `<not serializable>`, to `null`, or to a dropped entry, so telemetry can
 * never fail a model call.
 */

import {
  Content,
  ContentUnion,
  FinishReason,
  GenerateContentResponseUsageMetadata,
  Part,
  PartUnion,
  Tool,
} from '@google/genai';
import {context, Span, trace} from '@opentelemetry/api';
import type {
  AnyValue,
  AnyValueMap,
  Logger as OtelLogger,
} from '@opentelemetry/api-logs';

import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {logger} from '../utils/logger.js';
import {toSnakeCaseKey} from '../utils/object_notation_utils.js';

// ---------------------------------------------------------------------------
// Section A — Constants & emitted shapes
// ---------------------------------------------------------------------------

/** Written wherever a value cannot be represented. */
const NOT_SERIALIZABLE = '<not serializable>';

const GEN_AI_INPUT_MESSAGES = 'gen_ai.input.messages';
const GEN_AI_OUTPUT_MESSAGES = 'gen_ai.output.messages';
const GEN_AI_SYSTEM_INSTRUCTIONS = 'gen_ai.system_instructions';
const GEN_AI_TOOL_DEFINITIONS = 'gen_ai.tool.definitions';
const GEN_AI_RESPONSE_FINISH_REASONS = 'gen_ai.response.finish_reasons';
const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
const GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS =
  'gen_ai.usage.cache_read.input_tokens';
const GEN_AI_USAGE_REASONING_OUTPUT_TOKENS =
  'gen_ai.usage.reasoning.output_tokens';
const GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS =
  'gen_ai.usage.cache_creation.input_tokens';
const GEN_AI_USAGE_SYSTEM_INSTRUCTION_TOKENS =
  'gen_ai.usage.experimental.system_instruction_tokens';

const FUNCTION_TOOL_DEFINITION_TYPE = 'function';

/** Event name of the emitted completion-details log record. */
export const COMPLETION_DETAILS_EVENT_NAME =
  'gen_ai.client.inference.operation.details';

/** Key of the `Tool` field that carries declared functions. */
const FUNCTION_DECLARATIONS_KEY = 'functionDeclarations';

/** Name reported for a function declaration that carries none. */
const UNNAMED_FUNCTION_DECLARATION = 'FunctionDeclaration';

/** Name reported for a tool entry of an unrecognized shape. */
const UNSERIALIZABLE_TOOL = 'UnserializableTool';

/**
 * The emitted payload keys are `snake_case` because they are the wire contract
 * that downstream OpenTelemetry consumers read. They match adk-python's output
 * byte for byte, so they do not follow the repository's `camelCase` style.
 *
 * These are `type` aliases rather than `interface`s so that they carry an
 * implicit index signature and are assignable to `AnyValue` directly. An
 * `interface` is not, which would force a deep copy through {@link toAnyValue}
 * on data these builders have already normalized.
 */
type TextPart = {
  content: string;
  type: 'text';
};

type BlobPart = {
  mime_type: string;
  /** Base64, because `@google/genai` encodes `Blob.data` as a string. */
  data: string;
  type: 'blob';
};

type FileDataPart = {
  mime_type: string;
  uri: string;
  type: 'file_data';
};

type ToolCallPart = {
  id: string;
  name: string;
  arguments: AnyValueMap | null;
  type: 'tool_call';
};

type ToolCallResponsePart = {
  id: string;
  response: AnyValueMap | null;
  type: 'tool_call_response';
};

/** One entry of an emitted message's `parts` list. */
type SemconvPart =
  | TextPart
  | BlobPart
  | FileDataPart
  | ToolCallPart
  | ToolCallResponsePart;

/** One entry of `gen_ai.input.messages`. */
type InputMessage = {
  role: string;
  parts: SemconvPart[];
};

/** One entry of `gen_ai.output.messages`. */
type OutputMessage = {
  role: string;
  parts: SemconvPart[];
  finish_reason: string;
};

/** A declared function, reported with its JSON schema. */
type FunctionToolDefinition = {
  name: string;
  description: string | null;
  parameters: AnyValueMap | null;
  type: 'function';
};

/** A built-in tool, reported by name only. */
type GenericToolDefinition = {
  name: string;
  type: string;
};

/** One entry of `gen_ai.tool.definitions`. */
type ToolDefinition = FunctionToolDefinition | GenericToolDefinition;

/**
 * A tool descriptor that is not a `@google/genai` `Tool`, such as the plain
 * object the Model Context Protocol SDK produces at runtime.
 *
 * The schema arrives under three spellings. `@modelcontextprotocol/sdk` emits
 * `inputSchema`, and a `@google/genai` `FunctionDeclaration` uses `parameters`.
 * `input_schema` is what a descriptor that did not come from the TypeScript SDK
 * carries: a tool definition loaded from JSON, proxied from a Python MCP
 * server, or handed straight to `GenerateContentConfig.tools` by a caller
 * bypassing ADK. Reading all three costs one field and keeps the reported
 * schema equal to adk-python's, which reads the same three.
 */
export interface DumpedTool {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  inputSchema?: unknown;
  input_schema?: unknown;
}

/**
 * The two token counts `@google/genai` 2.9.0 does not declare on
 * `GenerateContentResponseUsageMetadata`.
 *
 * A `BaseLlm` that is not Gemini can still report them: Anthropic bills cache
 * writes separately from cache reads, so a model implementation wrapping it
 * sets `cacheCreationInputTokens` by hand. Neither count is read off a Gemini
 * response, and no model shipped in this repository sets either one today, so
 * both buckets stay absent until such a model exists. Declaring them keeps that
 * a typed field rather than a cast at the call site, and keeps the emitted
 * attribute set equal to adk-python's `TokenUsage.to_attributes()`, which reads
 * both the same way.
 */
export interface ExtendedUsageMetadata extends GenerateContentResponseUsageMetadata {
  cacheCreationInputTokens?: number;
  systemInstructionTokens?: number;
}

/**
 * The telemetry decisions this module reads.
 *
 * Structural rather than a class, so any object carrying the three decisions
 * satisfies it, including one that exposes them as getters.
 */
export interface ExperimentalSemconvConfig {
  readonly shouldUseExperimentalGenaiSemconv: boolean;
  readonly shouldAddContentToLogs: boolean;
  readonly shouldAddContentToExperimentalSpans: boolean;
}

// ---------------------------------------------------------------------------
// Section B — Pure builders
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isByteArray(value)
  );
}

function isAnyValueMap(value: AnyValue): value is AnyValueMap {
  return isRecord(value);
}

/**
 * `Uint8Array` is a JavaScript built-in, so a second copy of adk-js in the same
 * runtime does not give it a second identity. The objection to `instanceof` in
 * the style guide is about class identity across package copies, which cannot
 * apply to it.
 */
function isByteArray(value: object): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** Whether `value` is a plain object rather than a class instance. */
function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * A readable label for a value's kind. This names a type for a human to read;
 * it is not a type check, and nothing branches on it.
 */
function typeName(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return typeof value;
  }
  return value.constructor?.name ?? 'object';
}

function recordToAnyValue(
  value: Record<string, unknown>,
  path: Set<object>,
): AnyValueMap {
  const normalized: AnyValueMap = {};
  for (const [key, item] of Object.entries(value)) {
    // The counterpart of pydantic's `exclude_none=True`. An explicit `null`
    // survives, because the redacted tool view emits `description: null`.
    if (item !== undefined) {
      normalized[key] = toAnyValue(item, path);
    }
  }
  return normalized;
}

function objectToAnyValue(value: object, path: Set<object>): AnyValue {
  if (Array.isArray(value)) {
    return value.map((item) => toAnyValue(item, path));
  }
  if (isPlainObject(value)) {
    return recordToAnyValue(value, path);
  }
  return NOT_SERIALIZABLE;
}

/**
 * Normalizes a dynamic value to OpenTelemetry's recursive log value type.
 *
 * `path` holds the objects on the current branch, so a cycle degrades to
 * `<not serializable>` while the same object referenced twice side by side is
 * still normalized twice.
 */
export function toAnyValue(
  value: unknown,
  path: Set<object> = new Set(),
): AnyValue {
  if (value === null || value === undefined) {
    return value;
  }
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'object':
      break;
    default:
      return NOT_SERIALIZABLE;
  }

  const object = value as object;
  if (isByteArray(object)) {
    return object;
  }
  if (path.has(object)) {
    return NOT_SERIALIZABLE;
  }

  path.add(object);
  const normalized = objectToAnyValue(object, path);
  path.delete(object);
  return normalized;
}

/** Normalizes optional tool arguments and responses to a map. */
function toOptionalMap(value: unknown): AnyValueMap | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = toAnyValue(value);
  return isAnyValueMap(normalized) ? normalized : {'value': normalized};
}

function toRole(role: string | undefined): string {
  if (role === 'user') {
    return 'user';
  }
  if (role === 'model') {
    return 'assistant';
  }
  return '';
}

/**
 * Whether the model reported why generation stopped.
 *
 * `FINISH_REASON_UNSPECIFIED` is the proto3 zero value, so the field carries it
 * when the model set nothing, and it is a truthy string in the TypeScript enum.
 * Counting it as a reason of its own publishes a turn that ended normally as a
 * failed one. Excluding it here is what makes the caller omit
 * `gen_ai.response.finish_reasons` instead of emitting a value for it.
 *
 * adk-python draws the same distinction, in `telemetry/_finish_reason.py`. Its
 * test `test_response_attributes_treat_unspecified_finish_reason_as_unreported`
 * pins both halves: the attribute is absent, and the output message still
 * carries `finish_reason: ''`. The ported test of the same name pins them here.
 */
function isReportedFinishReason(
  finishReason: FinishReason | undefined,
): finishReason is FinishReason {
  return (
    finishReason !== undefined &&
    finishReason !== FinishReason.FINISH_REASON_UNSPECIFIED
  );
}

/** Maps a genai finish reason onto the vocabulary the semconv JSON allows. */
function toFinishReason(finishReason: FinishReason | undefined): string {
  if (!isReportedFinishReason(finishReason)) {
    return '';
  }
  switch (finishReason) {
    // Mapped to error, as the JSON schema for finish_reason does not support it.
    case FinishReason.OTHER:
      return 'error';
    case FinishReason.STOP:
      return 'stop';
    case FinishReason.MAX_TOKENS:
      return 'length';
    default:
      return finishReason.toLowerCase();
  }
}

function toolCallIdFallback(name: string | undefined, index: number): string {
  return name ? `${name}_${index}` : `${index}`;
}

function toSemconvPart(part: Part, index: number): SemconvPart | null {
  if (part.text !== undefined) {
    return {content: part.text, type: 'text'};
  }
  if (part.inlineData) {
    return {
      mime_type: part.inlineData.mimeType ?? '',
      data: part.inlineData.data ?? '',
      type: 'blob',
    };
  }
  if (part.fileData) {
    return {
      mime_type: part.fileData.mimeType ?? '',
      uri: part.fileData.fileUri ?? '',
      type: 'file_data',
    };
  }
  if (part.functionCall) {
    const call = part.functionCall;
    return {
      id: call.id || toolCallIdFallback(call.name, index),
      name: call.name ?? '',
      arguments: toOptionalMap(call.args),
      type: 'tool_call',
    };
  }
  if (part.functionResponse) {
    const response = part.functionResponse;
    return {
      id: response.id || toolCallIdFallback(response.name, index),
      response: toOptionalMap(response.response),
      type: 'tool_call_response',
    };
  }
  return null;
}

function toSemconvParts(parts: readonly Part[]): SemconvPart[] {
  return parts
    .map((part, index) => toSemconvPart(part, index))
    .filter((part): part is SemconvPart => part !== null);
}

function toInputMessage(content: Content): InputMessage {
  return {
    role: toRole(content.role),
    parts: toSemconvParts(content.parts ?? []),
  };
}

function toOutputMessage(llmResponse: LlmResponse): OutputMessage | null {
  if (!llmResponse.content) {
    return null;
  }
  const message = toInputMessage(llmResponse.content);
  return {
    role: message.role,
    parts: message.parts,
    finish_reason: toFinishReason(llmResponse.finishReason),
  };
}

function isContent(value: Content | Part): value is Content {
  return 'parts' in value || 'role' in value;
}

function toGenaiPart(part: PartUnion): Part {
  return typeof part === 'string' ? {text: part} : part;
}

/**
 * Flattens a system instruction to bare parts, with no role wrapper.
 *
 * `createUserContent` from `@google/genai` covers most of `ContentUnion`, but
 * it throws on an empty list and on an unrecognized entry, so this module
 * normalizes the union itself.
 */
function toSystemInstructions(
  systemInstruction: ContentUnion | undefined,
): SemconvPart[] {
  if (!systemInstruction) {
    return [];
  }
  if (typeof systemInstruction === 'string') {
    return toSemconvParts([{text: systemInstruction}]);
  }
  if (Array.isArray(systemInstruction)) {
    return toSemconvParts(systemInstruction.map(toGenaiPart));
  }
  if (isContent(systemInstruction)) {
    return toSemconvParts(systemInstruction.parts ?? []);
  }
  return toSemconvParts([systemInstruction]);
}

/** Converts a parameter schema into a plain map. */
function cleanParameters(parameters: unknown): AnyValueMap | null {
  if (parameters === null || parameters === undefined) {
    return null;
  }
  const normalized = toAnyValue(parameters);
  if (isAnyValueMap(normalized)) {
    return normalized;
  }
  return {
    'type': 'object',
    'properties': {
      'serialization_error': {
        'type': 'string',
        'description': `Expected a mapping for parameters, got ${typeName(parameters)}`,
      },
    },
  };
}

/**
 * Reports a tool descriptor that is not a `@google/genai` `Tool`.
 *
 * The parameter schema is read under the three spellings {@link DumpedTool}
 * documents. An unknown spelling is not an error: the tool is still reported,
 * without parameters.
 */
export function toolDefinitionFromDumpedTool(
  tool: DumpedTool,
): FunctionToolDefinition {
  return {
    name:
      typeof tool.name === 'string' && tool.name ? tool.name : typeName(tool),
    description: typeof tool.description === 'string' ? tool.description : null,
    parameters: cleanParameters(
      tool.parameters ?? tool.inputSchema ?? tool.input_schema,
    ),
    type: FUNCTION_TOOL_DEFINITION_TYPE,
  };
}

function functionToolDefinitions(tool: Tool): FunctionToolDefinition[] {
  // The duck-type check that produced this `Tool` proves a key is present, not
  // that its value has the declared shape.
  const declarations = Array.isArray(tool.functionDeclarations)
    ? tool.functionDeclarations
    : [];
  return declarations.map((declaration) => ({
    name: declaration.name || UNNAMED_FUNCTION_DECLARATION,
    description: declaration.description ?? null,
    parameters: cleanParameters(
      declaration.parameters ?? declaration.parametersJsonSchema,
    ),
    type: FUNCTION_TOOL_DEFINITION_TYPE,
  }));
}

/**
 * Reports every non-function field of a `Tool` under its `snake_case` key, so
 * `googleSearch` reaches the wire as `google_search` like it does in
 * adk-python.
 */
function genericToolDefinitions(tool: Tool): GenericToolDefinition[] {
  return Object.entries(tool)
    .filter(
      ([key, value]) =>
        key !== FUNCTION_DECLARATIONS_KEY &&
        value !== null &&
        value !== undefined,
    )
    .map(([key]) => {
      const name = toSnakeCaseKey(key);
      return {name, type: name};
    });
}

/** Whether `value` carries at least one field of a `@google/genai` `Tool`. */
function isGenaiTool(value: object): value is Tool {
  return Object.keys(value).some((key) => GENAI_TOOL_KEYS.has(key));
}

/**
 * The definitions of `tool` when it looks like a `@google/genai` `Tool`, and
 * `undefined` otherwise.
 */
function genaiToolDefinitions(
  tool: Record<string, unknown>,
): ToolDefinition[] | undefined {
  if (!isGenaiTool(tool)) {
    return undefined;
  }
  return [...functionToolDefinitions(tool), ...genericToolDefinitions(tool)];
}

const GENAI_TOOL_KEYS = new Set<string>([
  FUNCTION_DECLARATIONS_KEY,
  'codeExecution',
  'computerUse',
  'enterpriseWebSearch',
  'fileSearch',
  'googleMaps',
  'googleSearch',
  'googleSearchRetrieval',
  'mcpServers',
  'parallelAiSearch',
  'retrieval',
  'urlContext',
]);

/** Whether `value` is a `@google/genai` `CallableTool`. */
function isCallableTool(value: Record<string, unknown>): boolean {
  return typeof value['tool'] === 'function';
}

/**
 * Converts a single tool entry into definitions.
 *
 * The parameter is `unknown` rather than `ToolUnion` on purpose: by the time
 * telemetry reads `llmRequest.config.tools`, ADK's pipeline has materialized
 * every `BaseTool` into a `Tool`, but a caller using `@google/genai` directly
 * can put any value there, and this module must still report something.
 */
function toToolDefinitions(tool: unknown): ToolDefinition[] {
  if (typeof tool === 'function') {
    return [
      {
        name: tool.name || 'Function',
        // JavaScript has no docstring, so there is no counterpart of the
        // description adk-python reads from `__doc__`.
        description: '',
        parameters: null,
        type: FUNCTION_TOOL_DEFINITION_TYPE,
      },
    ];
  }

  if (isRecord(tool)) {
    const genaiDefinitions = genaiToolDefinitions(tool);
    if (genaiDefinitions) {
      return genaiDefinitions;
    }
    if (isCallableTool(tool)) {
      // Resolving one needs `await tool()`, which would make every builder
      // async for a case ADK's own pipeline never produces.
      logger.warn(
        'Unresolved CallableTool found in telemetry emission. Some tool' +
          ' definitions may be dropped',
      );
      return [];
    }
    if (typeof tool.name === 'string') {
      return [toolDefinitionFromDumpedTool(tool)];
    }
  }

  return [{name: UNSERIALIZABLE_TOOL, type: typeName(tool)}];
}

/** Flattens a list of tool entries into definitions. */
export function resolveToolDefinitions(
  tools: readonly unknown[],
): ToolDefinition[] {
  return tools.flatMap(toToolDefinitions);
}

/**
 * Returns a no-content view of the operation-details attributes.
 *
 * Function-tool `parameters` are privacy sensitive and become `null`; generic
 * tool definitions survive verbatim. Nothing else survives.
 */
function operationDetailsAttributesNoContent(
  attributes: AnyValueMap,
): AnyValueMap {
  const toolDefinitions = attributes[GEN_AI_TOOL_DEFINITIONS];
  if (!Array.isArray(toolDefinitions) || toolDefinitions.length === 0) {
    return {};
  }

  const redacted: AnyValue[] = [];
  for (const definition of toolDefinitions) {
    if (!isAnyValueMap(definition)) {
      continue;
    }
    const name = definition['name'];
    const toolType = definition['type'];
    if (typeof name !== 'string' || typeof toolType !== 'string') {
      continue;
    }
    if ('parameters' in definition) {
      const description = definition['description'];
      redacted.push({
        'name': name,
        'description': typeof description === 'string' ? description : null,
        'parameters': null,
        'type': FUNCTION_TOOL_DEFINITION_TYPE,
      });
    } else {
      redacted.push({'name': name, 'type': toolType});
    }
  }
  return {[GEN_AI_TOOL_DEFINITIONS]: redacted};
}

function isPresent(value: number | null | undefined): value is number {
  return value !== null && value !== undefined;
}

function sumTokens(
  first: number | null | undefined,
  second: number | null | undefined,
): number | null {
  if (!isPresent(first) && !isPresent(second)) {
    return null;
  }
  return (first ?? 0) + (second ?? 0);
}

/**
 * Reproduces `TokenUsage.to_attributes()` from adk-python's
 * `src/google/adk/telemetry/_token_usage.py`. That module is a separate parity
 * task, and its port replaces this helper's call site.
 */
function tokenUsageAttributes(
  usageMetadata: ExtendedUsageMetadata,
): AnyValueMap {
  const attributes: AnyValueMap = {};

  // Tool-use prompt tokens count as input, and reasoning tokens as output.
  const inputTokens = sumTokens(
    usageMetadata.promptTokenCount,
    usageMetadata.toolUsePromptTokenCount,
  );
  if (isPresent(inputTokens)) {
    attributes[GEN_AI_USAGE_INPUT_TOKENS] = inputTokens;
  }
  const outputTokens = sumTokens(
    usageMetadata.candidatesTokenCount,
    usageMetadata.thoughtsTokenCount,
  );
  if (isPresent(outputTokens)) {
    attributes[GEN_AI_USAGE_OUTPUT_TOKENS] = outputTokens;
  }
  if (isPresent(usageMetadata.cachedContentTokenCount)) {
    attributes[GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS] =
      usageMetadata.cachedContentTokenCount;
  }
  if (isPresent(usageMetadata.cacheCreationInputTokens)) {
    attributes[GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS] =
      usageMetadata.cacheCreationInputTokens;
  }
  if (isPresent(usageMetadata.thoughtsTokenCount)) {
    attributes[GEN_AI_USAGE_REASONING_OUTPUT_TOKENS] =
      usageMetadata.thoughtsTokenCount;
  }
  if (isPresent(usageMetadata.systemInstructionTokens)) {
    attributes[GEN_AI_USAGE_SYSTEM_INSTRUCTION_TOKENS] =
      usageMetadata.systemInstructionTokens;
  }
  return attributes;
}

/**
 * Serializes a span attribute value to compact JSON.
 *
 * `JSON.stringify` produces no whitespace and does not escape non-ASCII, which
 * is the compact form adk-python emits. It throws on a cycle or a `BigInt`, and
 * returns `undefined` for a value it drops, such as a function.
 */
function safeJsonSerialize(value: AnyValue): string {
  try {
    return JSON.stringify(value) ?? NOT_SERIALIZABLE;
  } catch {
    return NOT_SERIALIZABLE;
  }
}

/** The attributes to attach to the emitted completion log record. */
function completionLogAttributes(
  telemetryConfig: ExperimentalSemconvConfig,
  details: AnyValueMap,
  common: AnyValueMap,
): AnyValueMap {
  const content = telemetryConfig.shouldAddContentToLogs
    ? details
    : operationDetailsAttributesNoContent(details);
  return {...common, ...content};
}

// ---------------------------------------------------------------------------
// Section C — Attribute setters & log emission
// ---------------------------------------------------------------------------

/**
 * Copies `attributes` into `common`, and `logOnlyAttributes` as well when the
 * config routes content onto the log record.
 *
 * `logOnlyAttributes` carries what may reach a log record but not a span, such
 * as the end user's id. adk-python's sole caller is `tracing.py`, which passes
 * it on every call; the port of that module is this function's caller here too.
 */
export function setOperationDetailsCommonAttributes(
  common: AnyValueMap,
  telemetryConfig: ExperimentalSemconvConfig,
  attributes: AnyValueMap,
  logOnlyAttributes?: AnyValueMap,
): void {
  Object.assign(common, attributes);
  if (logOnlyAttributes && telemetryConfig.shouldAddContentToLogs) {
    Object.assign(common, logOnlyAttributes);
  }
}

/**
 * Writes the three request keys into `attributes`. All three are written for
 * every request, with empty lists when the request carries nothing.
 */
export function setOperationDetailsAttributesFromRequest(
  attributes: AnyValueMap,
  llmRequest: LlmRequest,
): void {
  attributes[GEN_AI_INPUT_MESSAGES] = llmRequest.contents.map(toInputMessage);
  attributes[GEN_AI_SYSTEM_INSTRUCTIONS] = toSystemInstructions(
    llmRequest.config?.systemInstruction,
  );
  attributes[GEN_AI_TOOL_DEFINITIONS] = resolveToolDefinitions(
    llmRequest.config?.tools ?? [],
  );
}

/**
 * Writes the response keys: the output message into `details`, the finish
 * reason and the token counters into `common`.
 *
 * Call it once per response. A turn that arrives as several streamed responses
 * is reported as all of them, one message each.
 */
export function setOperationDetailsAttributesFromResponse(
  llmResponse: LlmResponse,
  details: AnyValueMap,
  common: AnyValueMap,
): void {
  // An unreported finish reason maps to '': omit the attribute rather than
  // publish that.
  const finishReason = toFinishReason(llmResponse.finishReason);
  if (finishReason) {
    common[GEN_AI_RESPONSE_FINISH_REASONS] = [finishReason];
  }
  if (llmResponse.usageMetadata) {
    Object.assign(common, tokenUsageAttributes(llmResponse.usageMetadata));
  }

  const outputMessage = toOutputMessage(llmResponse);
  if (outputMessage) {
    const recorded = details[GEN_AI_OUTPUT_MESSAGES];
    details[GEN_AI_OUTPUT_MESSAGES] = Array.isArray(recorded)
      ? [...recorded, outputMessage]
      : [outputMessage];
  }
}

/**
 * Emits the completion-details log record and mirrors it onto `span`.
 *
 * Does nothing without a span, and nothing when the config has not opted in to
 * the experimental semantic conventions.
 */
export function maybeLogCompletionDetails(
  span: Span | undefined,
  otelLogger: OtelLogger,
  details: AnyValueMap,
  common: AnyValueMap,
  telemetryConfig: ExperimentalSemconvConfig,
): void {
  if (!span || !telemetryConfig.shouldUseExperimentalGenaiSemconv) {
    return;
  }

  otelLogger.emit({
    eventName: COMPLETION_DETAILS_EVENT_NAME,
    attributes: completionLogAttributes(telemetryConfig, details, common),
    // Built from the named span rather than read from ambient state, because
    // a caller is not required to have made it current.
    context: trace.setSpan(context.active(), span),
  });

  const spanAttributes = telemetryConfig.shouldAddContentToExperimentalSpans
    ? details
    : operationDetailsAttributesNoContent(details);
  for (const [key, value] of Object.entries(spanAttributes)) {
    span.setAttribute(key, safeJsonSerialize(value));
  }
}
