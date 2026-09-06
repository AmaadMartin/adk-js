/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Behavior,
  Blob,
  Content,
  createPartFromText,
  createUserContent,
  FileData,
  FunctionDeclaration,
  GenerateContentConfig,
  LiveConnectConfig,
  SchemaUnion,
  Tool,
  ToolUnion,
} from '@google/genai';

import {ContextCacheConfig} from '../agents/context_cache_config.js';
import type {BaseTool} from '../tools/base_tool.js';
import {logger} from '../utils/logger.js';
import {CacheMetadata} from './cache_metadata.js';

/**
 * LLM request class that allows passing in tools, output schema and system
 * instructions to the model.
 */
export interface LlmRequest {
  /**
   * The model name.
   */
  model?: string;

  /**
   * The contents to send to the model.
   */
  contents: Content[];

  /**
   * Additional config for the generate content request.
   * Tools in generateContentConfig should not be set directly; use appendTools.
   */
  config?: GenerateContentConfig;

  liveConnectConfig: LiveConnectConfig;

  /**
   * The tools dictionary. Excluded from JSON serialization.
   */
  toolsDict: {[key: string]: BaseTool};

  /**
   * The set of allowed tools, populated by request processors.
   */
  allowedTools?: string[];

  /**
   * Whether a managed agent built the request. A managed agent resolves its
   * tools server-side, so the request carries no model. Built-in tools read
   * this flag to enable themselves on such a request. Internal request state.
   *
   * Mirrors `LlmRequest._is_managed_agent` in google/adk-python
   * `models/llm_request.py`.
   */
  isManagedAgent?: boolean;

  /**
   * The interaction ID from the previous turn, if any.
   */
  previousInteractionId?: string;

  /**
   * Context cache configuration for this request.
   */
  cacheConfig?: ContextCacheConfig;

  /**
   * Cache metadata from previous requests, used for cache management.
   */
  cacheMetadata?: CacheMetadata;

  /**
   * Token count from the previous request's prompt, used for cache size
   * validation.
   */
  cacheableContentsTokenCount?: number;

  /**
   * Whether the request carries non-text static-instruction content. Such
   * content must stay a stable request prefix across turns, so that
   * provider-side context caching can key off it. Internal request state.
   */
  hasStaticInstruction?: boolean;

  /**
   * Index in `contents` immediately after the static-instruction prefix, once
   * that prefix sits at the front of the request. Internal request state.
   */
  staticInstructionPrefixEndIndex?: number;

  /**
   * Instructions contributed by tools while the request is being built. They
   * are resolved into the system instruction once every tool has processed the
   * request, so a tool does not have to know where instructions ultimately go.
   * Internal request state.
   */
  dynamicInstructions?: string[];
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/**
 * `Content` is a structural interface, so there is no constructor to test
 * against. A non-array object carrying either of its two fields is one.
 *
 * Named for what it tests, because `workflow/base_node.ts` exports a stricter
 * `isContent` that rejects a `Content` carrying only a role.
 */
export function isContentLike(value: unknown): value is Content {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    ('parts' in value || 'role' in value)
  );
}

function ensureConfig(llmRequest: LlmRequest): GenerateContentConfig {
  if (!llmRequest.config) {
    llmRequest.config = {};
  }
  return llmRequest.config;
}

/**
 * The model API accepts only a string system instruction, so an existing value
 * of any other shape is left alone rather than stringified into it.
 */
function appendToSystemInstruction(
  config: GenerateContentConfig,
  text: string,
): void {
  if (!config.systemInstruction) {
    config.systemInstruction = text;
    return;
  }
  if (typeof config.systemInstruction === 'string') {
    config.systemInstruction += '\n\n' + text;
    return;
  }
  logger.warn(
    `Cannot append to systemInstruction of unsupported type: ` +
      `${typeof config.systemInstruction}. Only a string systemInstruction ` +
      `is supported.`,
  );
}

function referenceLine(
  label: string,
  referenceId: string,
  descriptor: string[],
): string {
  const suffix = descriptor.length ? ` (${descriptor.join(', ')})` : '';
  return `[Reference to ${label}: ${referenceId}${suffix}]`;
}

function inlineDataDescriptor(data: Blob): string[] {
  const descriptor: string[] = [];
  if (data.displayName) {
    descriptor.push(`'${data.displayName}'`);
  }
  if (data.mimeType) {
    descriptor.push(`type: ${data.mimeType}`);
  }
  return descriptor;
}

function fileDataDescriptor(data: FileData): string[] {
  const descriptor: string[] = [];
  if (data.displayName) {
    descriptor.push(`'${data.displayName}'`);
  }
  if (data.fileUri) {
    descriptor.push(`URI: ${data.fileUri}`);
  }
  if (data.mimeType) {
    descriptor.push(`type: ${data.mimeType}`);
  }
  return descriptor;
}

function appendContentInstructions(
  config: GenerateContentConfig,
  llmRequest: LlmRequest,
  instructions: Content,
): Content[] {
  const textParts: string[] = [];
  const userContents: Content[] = [];
  let nonTextCount = 0;

  for (const part of instructions.parts ?? []) {
    if (part.text) {
      textParts.push(part.text);
    } else if (part.inlineData) {
      const referenceId = `inline_data_${nonTextCount++}`;
      textParts.push(
        referenceLine(
          'inline binary data',
          referenceId,
          inlineDataDescriptor(part.inlineData),
        ),
      );
      userContents.push(
        createUserContent([
          createPartFromText(`Referenced inline data: ${referenceId}`),
          {inlineData: part.inlineData},
        ]),
      );
    } else if (part.fileData) {
      const referenceId = `file_data_${nonTextCount++}`;
      textParts.push(
        referenceLine(
          'file data',
          referenceId,
          fileDataDescriptor(part.fileData),
        ),
      );
      userContents.push(
        createUserContent([
          createPartFromText(`Referenced file data: ${referenceId}`),
          {fileData: part.fileData},
        ]),
      );
    }
  }

  if (textParts.length) {
    appendToSystemInstruction(config, textParts.join('\n\n'));
  }

  if (userContents.length) {
    llmRequest.contents.push(...userContents);
    llmRequest.hasStaticInstruction = true;
  }

  return userContents;
}

/**
 * Appends instructions to the system instruction.
 *
 * The model API accepts only a string system instruction. A `Content` may also
 * carry inline or file data, so each such part becomes a textual reference in
 * the system instruction plus a user content appended to
 * {@link LlmRequest.contents}.
 *
 * @param instructions The instructions to append.
 * @returns The user contents synthesized from non-text parts, empty on every
 *     other path.
 * @throws TypeError if `instructions` is neither a `string[]` nor a `Content`.
 */
export function appendInstructions(
  llmRequest: LlmRequest,
  instructions: string[] | Content,
): Content[] {
  const config = ensureConfig(llmRequest);

  if (isStringArray(instructions)) {
    if (instructions.length) {
      appendToSystemInstruction(config, instructions.join('\n\n'));
    }
    return [];
  }
  if (isContentLike(instructions)) {
    return appendContentInstructions(config, llmRequest, instructions);
  }
  throw new TypeError(
    `instructions must be string[] or Content, got ${typeof instructions}.`,
  );
}

/**
 * Appends instructions contributed by a tool, to be resolved once every tool
 * has processed the request.
 *
 * @param instructions The instructions to accumulate.
 */
export function appendDynamicInstructions(
  llmRequest: LlmRequest,
  instructions: string[],
): void {
  if (!instructions.length) {
    return;
  }
  if (!llmRequest.dynamicInstructions) {
    llmRequest.dynamicInstructions = [];
  }
  llmRequest.dynamicInstructions.push(...instructions);
}

/**
 * Resolves the accumulated dynamic instructions into the system instruction
 * and clears them, so a second call adds nothing.
 */
export function finalizeDynamicInstructions(llmRequest: LlmRequest): void {
  const instructions = llmRequest.dynamicInstructions;
  if (!instructions?.length) {
    return;
  }
  appendInstructions(llmRequest, [instructions.join('\n\n')]);
  instructions.length = 0;
}

/** A `Tool` that carries at least one function declaration. */
export type ToolWithFunctionDeclarations = Tool & {
  functionDeclarations: FunctionDeclaration[];
};

function hasFunctionDeclarations(
  tool: ToolUnion,
): tool is ToolWithFunctionDeclarations {
  return (
    'functionDeclarations' in tool &&
    Array.isArray(tool.functionDeclarations) &&
    tool.functionDeclarations.length > 0
  );
}

/**
 * Finds the request's tool that carries function declarations.
 *
 * The Gemini API accepts at most one such tool, so a caller adding
 * declarations merges them into this one when it exists. A tool whose
 * declaration list is empty or absent is not a match: it is some other kind of
 * tool entry, and appending to it would be a different request.
 *
 * @returns The tool carrying function declarations, if the request has one.
 */
export function findToolWithFunctionDeclarations(
  llmRequest: LlmRequest,
): ToolWithFunctionDeclarations | undefined {
  return (llmRequest.config?.tools ?? []).find(hasFunctionDeclarations);
}

/**
 * Appends tools to the request.
 * @param tools The tools to append.
 */
export function appendTools(llmRequest: LlmRequest, tools: BaseTool[]): void {
  if (!tools?.length) {
    return;
  }

  const functionDeclarations: FunctionDeclaration[] = [];
  for (const tool of tools) {
    const declaration = tool._getDeclaration();
    if (!declaration) {
      continue;
    }
    functionDeclarations.push(declaration);
    // `Object.hasOwn` rather than a plain lookup, so a tool named after an
    // `Object.prototype` member does not report a phantom duplicate.
    if (Object.hasOwn(llmRequest.toolsDict, tool.name)) {
      logger.warn(
        `Duplicate tool name '${tool.name}': the previously registered tool ` +
          `is shadowed and can no longer be called.`,
      );
    }
    llmRequest.toolsDict[tool.name] = tool;
  }

  if (!functionDeclarations.length) {
    return;
  }

  const config = ensureConfig(llmRequest);
  if (!config.tools) {
    config.tools = [];
  }

  const existingTool = findToolWithFunctionDeclarations(llmRequest);
  if (existingTool) {
    existingTool.functionDeclarations.push(...functionDeclarations);
    return;
  }
  config.tools.push({functionDeclarations});
}

/**
 * Marks the declarations of tools that set `responseScheduling` as
 * `NON_BLOCKING`.
 *
 * The Live API honours `FunctionResponse.scheduling` only for `NON_BLOCKING`
 * declarations, and `FunctionDeclaration.behavior` is supported by the
 * bidirectional API alone. Callers therefore apply this when opening a live
 * connection, never when building a `generateContent` request.
 */
export function markAsyncToolsNonBlocking(llmRequest: LlmRequest): void {
  for (const tool of llmRequest.config?.tools ?? []) {
    if (!('functionDeclarations' in tool)) {
      continue;
    }
    for (const declaration of tool.functionDeclarations ?? []) {
      const declaredTool = declaration.name
        ? llmRequest.toolsDict[declaration.name]
        : undefined;
      if (declaredTool?.responseScheduling !== undefined) {
        declaration.behavior = Behavior.NON_BLOCKING;
      }
    }
  }
}

/**
 * Inserts request-scoped user content at the current-turn boundary.
 *
 * Transient content, such as recalled memory or a dynamic instruction, belongs
 * before the latest run of ordinary user contents, but after a function
 * response while the model continues a tool-call turn. That boundary keeps the
 * content out of the reusable system and history prefix, and it never
 * separates a function call from its response.
 *
 * A request that carries non-text static-instruction content is a special
 * case: the first call places that content at the very front, and every later
 * call inserts after it, so the prefix stays stable for context caching.
 *
 * @param contents The request-scoped contents to insert.
 */
export function insertTransientUserContent(
  llmRequest: LlmRequest,
  contents: Content[],
): void {
  if (!contents.length) {
    return;
  }

  if (
    llmRequest.hasStaticInstruction &&
    llmRequest.staticInstructionPrefixEndIndex === undefined
  ) {
    llmRequest.contents.splice(0, 0, ...contents);
    llmRequest.staticInstructionPrefixEndIndex = contents.length;
    return;
  }

  let insertIndex = llmRequest.contents.length;
  while (insertIndex > 0) {
    const content = llmRequest.contents[insertIndex - 1];
    if (
      content.role !== 'user' ||
      content.parts?.some((part) => part.functionResponse)
    ) {
      break;
    }
    insertIndex--;
  }

  if (
    llmRequest.hasStaticInstruction &&
    llmRequest.staticInstructionPrefixEndIndex !== undefined
  ) {
    insertIndex = Math.max(
      insertIndex,
      llmRequest.staticInstructionPrefixEndIndex,
    );
  }

  llmRequest.contents.splice(insertIndex, 0, ...contents);
}

/** Thrown by {@link setOutputSchema} when the caller supplies no schema. */
export const MISSING_OUTPUT_SCHEMA_MESSAGE =
  'setOutputSchema requires an outputSchema: the request would otherwise ask ' +
  'the model for JSON with no schema to answer against.';

/**
 * Sets the output schema for the request and puts the model in JSON mode.
 *
 * `SchemaUnion` resolves to `unknown`, so the compiler accepts an explicit
 * `undefined` or `null` for a required parameter. The guard runs before any
 * mutation, so a rejected call leaves the request as it was.
 *
 * @param outputSchema The JSON Schema object the model must answer against.
 * @throws Error if `outputSchema` is `undefined` or `null`.
 */
export function setOutputSchema(
  llmRequest: LlmRequest,
  outputSchema: SchemaUnion,
): void {
  if (outputSchema == null) {
    throw new Error(MISSING_OUTPUT_SCHEMA_MESSAGE);
  }

  const config = ensureConfig(llmRequest);
  config.responseSchema = outputSchema;
  config.responseMimeType = 'application/json';
}
