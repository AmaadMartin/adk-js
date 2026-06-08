/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, FunctionCall, FunctionDeclaration, Part} from '@google/genai';

import {logger} from '../utils/logger.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';
import {Gemini, GeminiParams} from './google_llm.js';
import {appendInstructions, LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

interface GemmaFunctionCall {
  name?: string;
  function?: string;
  parameters?: Record<string, unknown>;
  args?: Record<string, unknown>;
}

/**
 * Integration for Gemma models exposed via the Gemini API.
 */
export class Gemma extends Gemini {
  override readonly model: string;

  constructor(params: GeminiParams) {
    if (!params.model) {
      params.model = 'gemma-3-27b-it';
    }
    super(params);
    this.model = params.model;
  }

  static override readonly supportedModels: Array<string | RegExp> = [
    /gemma.*/,
    /google\/gemma.*/,
  ];

  override get apiBackend(): GoogleLLMVariant {
    return GoogleLLMVariant.GEMINI_API;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const isGemmaModel =
      llmRequest.model && /^(google\/)?gemma.*/.test(llmRequest.model);
    if (!isGemmaModel) {
      throw new Error(
        `Requesting a non-Gemma model (${llmRequest.model}) with the Gemma LLM is not supported.`,
      );
    }

    await this.preprocessGemmaRequest(llmRequest);

    for await (const response of super.generateContentAsync(
      llmRequest,
      stream,
      abortSignal,
    )) {
      extractFunctionCallsFromResponse(response);
      yield response;
    }
  }

  private async preprocessGemmaRequest(llmRequest: LlmRequest): Promise<void> {
    moveFunctionCallsIntoSystemInstruction(llmRequest);

    if (llmRequest.config?.systemInstruction) {
      const systemInstruction = llmRequest.config.systemInstruction as string;
      const contents = llmRequest.contents;
      const instructionContent: Content = {
        role: 'user',
        parts: [{text: systemInstruction}],
      };

      if (contents && contents.length > 0) {
        const firstContent = contents[0];
        const isAlreadyPrepend =
          firstContent.role === 'user' &&
          firstContent.parts &&
          firstContent.parts.length === 1 &&
          firstContent.parts[0].text === systemInstruction;

        if (!isAlreadyPrepend) {
          llmRequest.contents = [instructionContent, ...contents];
        }
      } else {
        llmRequest.contents = [instructionContent];
      }

      llmRequest.config.systemInstruction = undefined;
    }
  }
}

/**
 * Converts function declarations to system instructions for Gemma.
 */
function moveFunctionCallsIntoSystemInstruction(llmRequest: LlmRequest): void {
  const newContents: Content[] = [];
  for (const contentItem of llmRequest.contents) {
    const {newParts, hasFunctionResponsePart, hasFunctionCallPart} =
      convertContentPartsForGemma(contentItem);

    if (hasFunctionResponsePart) {
      if (newParts.length > 0) {
        newContents.push({role: 'user', parts: newParts});
      }
    } else if (hasFunctionCallPart) {
      if (newParts.length > 0) {
        newContents.push({role: 'model', parts: newParts});
      }
    } else {
      newContents.push(contentItem);
    }
  }
  llmRequest.contents = newContents;

  if (!llmRequest.config?.tools) {
    return;
  }

  const allFunctionDeclarations: FunctionDeclaration[] = [];
  for (const toolItem of llmRequest.config.tools) {
    if (
      toolItem &&
      typeof toolItem === 'object' &&
      'functionDeclarations' in toolItem
    ) {
      const tool = toolItem as {functionDeclarations: FunctionDeclaration[]};
      if (tool.functionDeclarations) {
        allFunctionDeclarations.push(...tool.functionDeclarations);
      }
    }
  }

  if (allFunctionDeclarations.length > 0) {
    const systemInstruction = buildGemmaFunctionSystemInstruction(
      allFunctionDeclarations,
    );
    appendInstructions(llmRequest, [systemInstruction]);
  }

  llmRequest.config.tools = [];
}

/**
 * Converts function call/response parts within a content item to text parts.
 */
function convertContentPartsForGemma(contentItem: Content): {
  newParts: Part[];
  hasFunctionResponsePart: boolean;
  hasFunctionCallPart: boolean;
} {
  const newParts: Part[] = [];
  let hasFunctionResponsePart = false;
  let hasFunctionCallPart = false;

  const parts = contentItem.parts ?? [];
  for (const part of parts) {
    if (part.functionResponse) {
      hasFunctionResponsePart = true;
      const responseText = `Invoking tool \`${part.functionResponse.name}\` produced: \`${JSON.stringify(part.functionResponse.response)}\`.`;
      newParts.push({text: responseText});
    } else if (part.functionCall) {
      hasFunctionCallPart = true;
      newParts.push({text: JSON.stringify(part.functionCall)});
    } else {
      newParts.push(part);
    }
  }

  return {newParts, hasFunctionResponsePart, hasFunctionCallPart};
}

/**
 * Constructs the system instruction string for Gemma function calling.
 */
function buildGemmaFunctionSystemInstruction(
  functionDeclarations: FunctionDeclaration[],
): string {
  const systemInstructionPrefix =
    'You have access to the following functions:\n[';
  const instructionParts: string[] = [];
  for (const func of functionDeclarations) {
    instructionParts.push(JSON.stringify(func));
  }

  const separator = ',\n';
  let systemInstruction = `${systemInstructionPrefix}${instructionParts.join(separator)}\n]\n`;
  systemInstruction +=
    'When you call a function, you MUST respond in the format of: ' +
    '{"name": function name, "parameters": dictionary of argument name and its value}\n' +
    'When you call a function, you MUST NOT include any other text in the response.\n';

  return systemInstruction;
}

/**
 * Extracts function calls from Gemma text responses.
 */
function extractFunctionCallsFromResponse(llmResponse: LlmResponse): void {
  if (llmResponse.partial || llmResponse.turnComplete === true) {
    return;
  }

  if (!llmResponse.content?.parts || llmResponse.content.parts.length !== 1) {
    return;
  }

  const responseText = llmResponse.content.parts[0].text;
  if (!responseText) {
    return;
  }

  try {
    let jsonCandidate: string | null = null;

    const markdownCodeBlockPattern =
      /```(?:json|tool_code)?\s*([\s\S]*?)\s*```/;
    const match = responseText.match(markdownCodeBlockPattern);

    if (match) {
      jsonCandidate = match[1].trim();
    } else {
      const [found, jsonText] = getLastValidJsonSubstring(responseText);
      if (found) {
        jsonCandidate = jsonText;
      }
    }

    if (!jsonCandidate) {
      return;
    }

    const parsed = JSON.parse(jsonCandidate) as GemmaFunctionCall;
    const name = parsed.name ?? parsed.function;
    const args = parsed.parameters ?? parsed.args;

    if (!name || typeof name !== 'string') {
      return;
    }

    const functionCall: FunctionCall = {
      name,
      args: args ?? {},
    };

    llmResponse.content.parts = [{functionCall}];
  } catch (e) {
    logger.debug(
      `Error attempting to parse JSON into function call. Leaving as text response. ${e}`,
    );
  }
}

/**
 * Attempts to find and return the last valid JSON object in a string.
 */
export function getLastValidJsonSubstring(
  text: string,
): [boolean, string | null] {
  let lastJsonStr: string | null = null;
  let startPos = 0;

  while (startPos < text.length) {
    const firstBraceIndex = text.indexOf('{', startPos);
    if (firstBraceIndex === -1) {
      break;
    }

    // Try to parse substrings starting at firstBraceIndex of increasing lengths
    let foundForThisBrace = false;
    for (let endPos = text.length; endPos > firstBraceIndex; endPos--) {
      const candidate = text.substring(firstBraceIndex, endPos);
      try {
        JSON.parse(candidate);
        lastJsonStr = candidate;
        startPos = endPos;
        foundForThisBrace = true;
        break;
      } catch {
        // Not a valid JSON substring yet
      }
    }

    if (!foundForThisBrace) {
      startPos = firstBraceIndex + 1;
    }
  }

  if (lastJsonStr !== null) {
    return [true, lastJsonStr];
  }
  return [false, null];
}
