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
   */
  isManagedAgent?: boolean;

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
    if (declaration) {
      functionDeclarations.push(declaration);
      llmRequest.toolsDict[tool.name] = tool;
    }
  }

  if (!functionDeclarations.length) {
    return;
  }

  if (!llmRequest.config) {
    llmRequest.config = {};
  }
  if (!llmRequest.config.tools) {
    llmRequest.config.tools = [];
  }

  const existingTool = findToolWithFunctionDeclarations(llmRequest);
  if (existingTool) {
    existingTool.functionDeclarations.push(...functionDeclarations);
    return;
  }
  llmRequest.config.tools.push({functionDeclarations});
}

/** Options for {@link setOutputSchema}. */
export interface SetOutputSchemaOptions {
  /**
   * @deprecated Alias for `outputSchema`. Pass `outputSchema` instead.
   */
  baseModel?: SchemaUnion;
}

/**
 * Sets the output schema for the request.
 *
 * The request is left untouched when this throws.
 *
 * @param outputSchema The JSON Schema object to set as the output schema.
 * @param options Additional options, holding the deprecated `baseModel` alias.
 * @throws Error if neither `outputSchema` nor `options.baseModel` is given.
 */
export function setOutputSchema(
  llmRequest: LlmRequest,
  outputSchema?: SchemaUnion,
  options: SetOutputSchemaOptions = {},
): void {
  const schema = outputSchema ?? options.baseModel;
  if (schema === undefined) {
    throw new Error(
      'Either outputSchema or baseModel must be provided. Pass ' +
        'outputSchema=<your schema> (baseModel is deprecated).',
    );
  }
  if (!llmRequest.config) {
    llmRequest.config = {};
  }
  llmRequest.config.responseSchema = schema;
  llmRequest.config.responseMimeType = 'application/json';
}
