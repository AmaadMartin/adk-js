/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  LiveConnectConfig,
  SchemaUnion,
} from '@google/genai';
import {Behavior, createUserContent} from '@google/genai';

import type {ContextCacheConfig} from '../agents/context_cache_config.js';
import type {BaseTool} from '../tools/base_tool.js';
import {contentUnionToText} from '../utils/content_utils.js';
import type {CacheMetadata} from './cache_metadata.js';

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
   * Context cache configuration for this request. Its presence is the opt-in
   * switch for context caching; when absent, caching is disabled.
   */
  cacheConfig?: ContextCacheConfig;

  /**
   * Cache metadata carried over from prior requests, used to validate and reuse
   * an existing cache across turns.
   */
  cacheMetadata?: CacheMetadata;

  /**
   * Prompt token count from the previous request, used to gate cache creation
   * by size. Absent on the first request of a session.
   */
  cacheableContentsTokenCount?: number;
}

/** Describes a part that the system instruction cannot carry. */
function partReference(
  kind: string,
  referenceId: string,
  descriptors: Array<string | undefined>,
): string {
  const shown = descriptors.filter((descriptor): descriptor is string =>
    Boolean(descriptor),
  );
  const suffix = shown.length ? ` (${shown.join(', ')})` : '';
  return `[Reference to ${kind}: ${referenceId}${suffix}]`;
}

/** Appends text to the system instruction, separated by a blank line. */
function appendSystemInstructionText(llmRequest: LlmRequest, text: string) {
  if (!llmRequest.config) {
    llmRequest.config = {};
  }
  const existingInstruction = contentUnionToText(
    llmRequest.config.systemInstruction,
  );
  llmRequest.config.systemInstruction = existingInstruction
    ? `${existingInstruction}\n\n${text}`
    : text;
}

/**
 * `Content` is a structural interface, so there is no constructor to test
 * against. A non-array object carrying either of its two fields is one.
 *
 * Named for what it tests, because `utils/content_utils.ts` exports a stricter
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

/**
 * Appends instructions to the system instruction.
 *
 * `systemInstruction` is a `ContentUnion`, so any text it already carries is
 * flattened before the new instructions are appended. The field always holds a
 * string once this returns.
 *
 * The model API only accepts text as a system instruction. A `Content` whose
 * parts are not all text therefore contributes a textual reference for each
 * non-text part, and the part itself moves into {@link LlmRequest.contents} as
 * user content.
 *
 * @param instructions The instructions to append.
 * @throws TypeError if `instructions` is neither a `string[]` nor a `Content`.
 */
export function appendInstructions(
  llmRequest: LlmRequest,
  instructions: string[] | Content,
): void {
  if (Array.isArray(instructions)) {
    if (instructions.length) {
      appendSystemInstructionText(llmRequest, instructions.join('\n\n'));
    }
    return;
  }
  if (!isContentLike(instructions)) {
    throw new TypeError(
      `instructions must be string[] or Content, got ${typeof instructions}.`,
    );
  }

  const texts: string[] = [];
  const userContents: Content[] = [];
  let nonTextCount = 0;
  for (const part of instructions.parts ?? []) {
    if (part.text) {
      texts.push(part.text);
    } else if (part.inlineData) {
      const referenceId = `inline_data_${nonTextCount++}`;
      texts.push(
        partReference('inline binary data', referenceId, [
          part.inlineData.displayName && `'${part.inlineData.displayName}'`,
          part.inlineData.mimeType && `type: ${part.inlineData.mimeType}`,
        ]),
      );
      userContents.push(
        createUserContent([
          `Referenced inline data: ${referenceId}`,
          {inlineData: part.inlineData},
        ]),
      );
    } else if (part.fileData) {
      const referenceId = `file_data_${nonTextCount++}`;
      texts.push(
        partReference('file data', referenceId, [
          part.fileData.displayName && `'${part.fileData.displayName}'`,
          part.fileData.fileUri && `URI: ${part.fileData.fileUri}`,
          part.fileData.mimeType && `type: ${part.fileData.mimeType}`,
        ]),
      );
      userContents.push(
        createUserContent([
          `Referenced file data: ${referenceId}`,
          {fileData: part.fileData},
        ]),
      );
    }
  }

  if (texts.length) {
    appendSystemInstructionText(llmRequest, texts.join('\n\n'));
  }
  llmRequest.contents.push(...userContents);
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
    if (declaration) {
      functionDeclarations.push(declaration);
      llmRequest.toolsDict[tool.name] = tool;
    }
  }

  if (functionDeclarations.length) {
    if (!llmRequest.config) {
      llmRequest.config = {};
    }
    if (!llmRequest.config.tools) {
      llmRequest.config.tools = [];
    }
    llmRequest.config.tools.push({functionDeclarations});
  }
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
 * Sets the output schema for the request.
 *
 * @param schema The JSON Schema object to set as the output schema.
 */
export function setOutputSchema(
  llmRequest: LlmRequest,
  schema: SchemaUnion,
): void {
  if (!llmRequest.config) {
    llmRequest.config = {};
  }
  llmRequest.config.responseSchema = schema;
  llmRequest.config.responseMimeType = 'application/json';
}
