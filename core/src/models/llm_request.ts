/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
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
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/**
 * `Content` is a structural interface, so there is no constructor to test
 * against. A non-array object carrying either of its two fields is one.
 */
function isContent(value: unknown): value is Content {
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
 * the system instruction plus a user content holding the data itself.
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
  if (isContent(instructions)) {
    return appendContentInstructions(config, llmRequest, instructions);
  }
  throw new TypeError(
    `instructions must be string[] or Content, got ${typeof instructions}.`,
  );
}

function hasFunctionDeclarations(tool: ToolUnion): tool is Tool {
  return 'functionDeclarations' in tool;
}

/**
 * Finds the request's tool that carries function declarations.
 *
 * The Gemini API accepts at most one such tool, so a caller adding
 * declarations must merge them into this one when it exists.
 *
 * @returns The tool carrying function declarations, if the request has one.
 */
export function findToolWithFunctionDeclarations(
  llmRequest: LlmRequest,
): Tool | undefined {
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
  if (!existingTool) {
    config.tools.push({functionDeclarations});
    return;
  }
  if (!existingTool.functionDeclarations) {
    existingTool.functionDeclarations = [];
  }
  existingTool.functionDeclarations.push(...functionDeclarations);
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

/**
 * Sets the output schema for the request.
 *
 * @param schema The JSON Schema object to set as the output schema.
 */
export function setOutputSchema(
  llmRequest: LlmRequest,
  schema: SchemaUnion,
): void {
  const config = ensureConfig(llmRequest);
  config.responseSchema = schema;
  config.responseMimeType = 'application/json';
}
