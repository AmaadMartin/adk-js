/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
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

/**
 * Appends instructions to the system instruction.
 * @param instructions The instructions to append.
 */
export function appendInstructions(
  llmRequest: LlmRequest,
  instructions: string[],
): void {
  if (!llmRequest.config) {
    llmRequest.config = {};
  }
  const newInstructions = instructions.join('\n\n');
  if (llmRequest.config.systemInstruction) {
    llmRequest.config.systemInstruction += '\n\n' + newInstructions;
  } else {
    llmRequest.config.systemInstruction = newInstructions;
  }
}

/**
 * Inserts request-scoped user content at the current-turn boundary.
 *
 * Transient content such as recalled memory belongs before the latest run of
 * ordinary user contents, but after a function response while the model
 * continues a tool-call turn. That boundary keeps the content out of the
 * reusable system and history prefix, so a provider can still cache the
 * prefix, and it never separates a function call from its response.
 *
 * adk-python also clamps the index against a static instruction prefix.
 * adk-js has no static instruction on a request, so this port does not model
 * that clamp.
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
