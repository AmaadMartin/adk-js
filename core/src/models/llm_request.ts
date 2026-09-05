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
  data: Blob | FileData,
): string {
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
  const suffix = descriptor.length ? ` (${descriptor.join(', ')})` : '';
  return `[Reference to ${label}: ${referenceId}${suffix}]`;
}

function appendContentInstructions(
  config: GenerateContentConfig,
  llmRequest: LlmRequest,
  instructions: Content,
): void {
  const textParts: string[] = [];
  const userContents: Content[] = [];
  let nonTextCount = 0;

  for (const part of instructions.parts ?? []) {
    if (part.text) {
      textParts.push(part.text);
    } else if (part.inlineData) {
      const referenceId = `inline_data_${nonTextCount++}`;
      textParts.push(
        referenceLine('inline binary data', referenceId, part.inlineData),
      );
      userContents.push(
        createUserContent([
          createPartFromText(`Referenced inline data: ${referenceId}`),
          {inlineData: part.inlineData},
        ]),
      );
    } else if (part.fileData) {
      const referenceId = `file_data_${nonTextCount++}`;
      textParts.push(referenceLine('file data', referenceId, part.fileData));
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
  llmRequest.contents.push(...userContents);
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
 * @throws TypeError if `instructions` is neither a `string[]` nor a `Content`.
 */
export function appendInstructions(
  llmRequest: LlmRequest,
  instructions: string[] | Content,
): void {
  llmRequest.config ??= {};

  if (isStringArray(instructions)) {
    if (instructions.length) {
      appendToSystemInstruction(llmRequest.config, instructions.join('\n\n'));
    }
    return;
  }
  if (isContentLike(instructions)) {
    appendContentInstructions(llmRequest.config, llmRequest, instructions);
    return;
  }
  throw new TypeError(
    `instructions must be string[] or Content, got ${typeof instructions}.`,
  );
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
