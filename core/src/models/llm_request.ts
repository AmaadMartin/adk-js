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
  Tool,
  ToolUnion,
} from '@google/genai';

import type {BaseTool} from '../tools/base_tool.js';
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
   * Instructions contributed by tools while the request is being built. They
   * are resolved into the system instruction once every tool has processed the
   * request, so a tool does not have to know where instructions ultimately go.
   * Internal request state.
   */
  dynamicInstructions?: string[];
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

/**
 * Appends instructions to the system instruction.
 * @param instructions The instructions to append.
 */
export function appendInstructions(
  llmRequest: LlmRequest,
  instructions: string[],
): void {
  if (!instructions.length) {
    return;
  }
  appendToSystemInstruction(
    ensureConfig(llmRequest),
    instructions.join('\n\n'),
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
