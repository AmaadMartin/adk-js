/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Blob,
  Content,
  createUserContent,
  FileData,
  FunctionDeclaration,
  GenerateContentConfig,
  LiveConnectConfig,
  SchemaUnion,
} from '@google/genai';

import {BaseTool} from '../tools/base_tool.js';

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

/** Renders the ` (a, b)` suffix of a reference, or `''` when it has none. */
function referenceSuffix(descriptors: string[]): string {
  return descriptors.length ? ` (${descriptors.join(', ')})` : '';
}

/** Describes an inline binary part that the system instruction cannot carry. */
function inlineDataReference(data: Blob, referenceId: string): string {
  const descriptors: string[] = [];
  if (data.displayName) {
    descriptors.push(`'${data.displayName}'`);
  }
  if (data.mimeType) {
    descriptors.push(`type: ${data.mimeType}`);
  }
  return `[Reference to inline binary data: ${referenceId}${referenceSuffix(
    descriptors,
  )}]`;
}

/** Describes a file part that the system instruction cannot carry. */
function fileDataReference(data: FileData, referenceId: string): string {
  const descriptors: string[] = [];
  if (data.displayName) {
    descriptors.push(`'${data.displayName}'`);
  }
  if (data.fileUri) {
    descriptors.push(`URI: ${data.fileUri}`);
  }
  if (data.mimeType) {
    descriptors.push(`type: ${data.mimeType}`);
  }
  return `[Reference to file data: ${referenceId}${referenceSuffix(
    descriptors,
  )}]`;
}

/** Appends text to the system instruction, separated by a blank line. */
function appendSystemInstructionText(llmRequest: LlmRequest, text: string) {
  if (!llmRequest.config) {
    llmRequest.config = {};
  }
  if (llmRequest.config.systemInstruction) {
    llmRequest.config.systemInstruction += '\n\n' + text;
  } else {
    llmRequest.config.systemInstruction = text;
  }
}

/**
 * Appends instructions to the system instruction.
 *
 * The model API only accepts text as a system instruction. A `Content` whose
 * parts are not all text therefore contributes a textual reference for each
 * non-text part, and the part itself moves into {@link LlmRequest.contents} as
 * user content.
 *
 * @param instructions The instructions to append.
 * @returns The user contents extracted from non-text parts, which are also
 *     appended to {@link LlmRequest.contents}. Empty for a list of strings.
 */
export function appendInstructions(
  llmRequest: LlmRequest,
  instructions: string[] | Content,
): Content[] {
  if (Array.isArray(instructions)) {
    if (instructions.length) {
      appendSystemInstructionText(llmRequest, instructions.join('\n\n'));
    }
    return [];
  }

  const texts: string[] = [];
  const userContents: Content[] = [];
  let nonTextCount = 0;
  for (const part of instructions.parts ?? []) {
    if (part.text) {
      texts.push(part.text);
    } else if (part.inlineData) {
      const referenceId = `inline_data_${nonTextCount++}`;
      texts.push(inlineDataReference(part.inlineData, referenceId));
      userContents.push(
        createUserContent([
          `Referenced inline data: ${referenceId}`,
          {inlineData: part.inlineData},
        ]),
      );
    } else if (part.fileData) {
      const referenceId = `file_data_${nonTextCount++}`;
      texts.push(fileDataReference(part.fileData, referenceId));
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
  return userContents;
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
