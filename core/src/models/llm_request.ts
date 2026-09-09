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
} from '@google/genai';

import {BaseTool} from '../tools/base_tool.js';
import {logger} from '../utils/logger.js';

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
   * Whether the request carries non-text static-instruction content. Such
   * content must stay a stable request prefix across turns, so that
   * provider-side context caching can key off it. Internal request state.
   */
  hasStaticInstruction?: boolean;
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

/** A `Blob` has no URI, so that entry is simply absent for inline data. */
function dataDescriptor(data: Blob | FileData): string[] {
  const descriptor: string[] = [];
  if (data.displayName) {
    descriptor.push(`'${data.displayName}'`);
  }
  if ('fileUri' in data && data.fileUri) {
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
          dataDescriptor(part.inlineData),
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
        referenceLine('file data', referenceId, dataDescriptor(part.fileData)),
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
 */
export function appendInstructions(
  llmRequest: LlmRequest,
  instructions: string[] | Content,
): Content[] {
  const config = (llmRequest.config ??= {});

  if (Array.isArray(instructions)) {
    if (instructions.length) {
      appendToSystemInstruction(config, instructions.join('\n\n'));
    }
    return [];
  }
  return appendContentInstructions(config, llmRequest, instructions);
}

/**
 * Inserts request-scoped user content at the current-turn boundary.
 *
 * Transient content, such as a dynamic instruction, belongs before the latest
 * run of ordinary user contents, but after a function response while the model
 * continues a tool-call turn. That boundary keeps the content out of the
 * reusable system and history prefix, and it never separates a function call
 * from its response.
 *
 * A request that carries non-text static-instruction content is a special
 * case: the content goes to the very front, so the prefix stays stable for
 * context caching.
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

  if (llmRequest.hasStaticInstruction) {
    llmRequest.contents.unshift(...contents);
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

  llmRequest.contents.splice(insertIndex, 0, ...contents);
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
