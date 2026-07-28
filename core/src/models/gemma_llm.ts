/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  createPartFromText,
  FunctionDeclaration,
  Part,
} from '@google/genai';

import {logger} from '../utils/logger.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

import {Gemini, GeminiParams} from './google_llm.js';
import {appendInstructions, LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/** The default Gemma 3 model used when no model name is supplied. */
const DEFAULT_GEMMA_MODEL = 'gemma-3-27b-it';

/**
 * Matches a markdown fenced code block, optionally tagged as `json` or
 * `tool_code`, capturing the inner content (group 1). JavaScript has no
 * `re.DOTALL`, so `[\s\S]` is used to match across newlines.
 */
const MARKDOWN_CODE_BLOCK_PATTERN = /```(?:json|tool_code)?\s*([\s\S]*?)\s*```/;

/**
 * Integration for Gemma 3 models exposed via the Gemini API (Google AI Studio).
 *
 * This class is for **Gemma 3 only**. Gemma 3 models do not have native
 * function calling or system instruction support, so this class applies three
 * workarounds automatically:
 * - Tool declarations are injected into a text prompt instead of being passed
 *   through the API.
 * - Function call / response parts already present in the conversation history
 *   are rewritten as plain text.
 * - Function calls are parsed back out of the model's text response.
 *
 * For Gemma 4 and later, use the standard {@link Gemini} class directly, which
 * has native function calling:
 *
 * ```ts
 * // Gemma 3 - use this class (workarounds applied automatically):
 * const agent = new LlmAgent({model: new Gemma({model: 'gemma-3-27b-it'})});
 *
 * // Gemma 4+ - use Gemini (native function calling):
 * const agent4 = new LlmAgent({model: new Gemini({model: 'gemma-4-<size>'})});
 * ```
 *
 * For agentic use cases with Gemma 3, `gemma-3-27b-it` and `gemma-3-12b-it`
 * are strongly recommended.
 *
 * For full documentation, see: https://ai.google.dev/gemma/docs/core/
 *
 * NOTE: This class only supports the Gemini API (Google AI Studio). Vertex AI
 * API support is not included.
 */
export class Gemma extends Gemini {
  /**
   * @param params The parameters for creating a Gemma instance. Reuses
   *   {@link GeminiParams}; when `model` is omitted it defaults to
   *   `'gemma-3-27b-it'`.
   */
  constructor(params: GeminiParams = {}) {
    super({...params, model: params.model ?? DEFAULT_GEMMA_MODEL});
  }

  /**
   * Model name patterns supported by this LLM. Only Gemma 3 (`gemma-*`)
   * resolves here; `gemma-4.*` is claimed by {@link Gemini} which is registered
   * first, so it resolves to the native class instead.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /gemma-.*/,
  ];

  /**
   * Gemma is only served through the Gemini API (Google AI Studio), so the
   * backend is forced regardless of environment configuration.
   */
  override get apiBackend(): GoogleLLMVariant {
    return GoogleLLMVariant.GEMINI_API;
  }

  /**
   * Sends a request to the Gemma model.
   *
   * The request is preprocessed to work around Gemma 3's lack of native
   * function calling, and each response is post-processed to surface any
   * text-encoded function call as a structured `functionCall` part.
   *
   * @param llmRequest The request to send to the model.
   * @param stream Whether to do a streaming call.
   * @param abortSignal Optional signal used to cancel the request.
   * @yields The model response(s).
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const model = llmRequest.model ?? this.model;
    if (!model.startsWith('gemma-')) {
      throw new Error(
        `Requesting a non-Gemma model (${model}) with the Gemma LLM is not supported.`,
      );
    }

    preprocessGemmaRequest(llmRequest);

    for await (const response of super.generateContentAsync(
      llmRequest,
      stream,
      abortSignal,
    )) {
      extractFunctionCallsFromResponse(response);
      yield response;
    }
  }
}

/**
 * Applies the Gemma request workarounds in order: move function declarations
 * and history function call/response parts into text, then hoist the system
 * instruction into a leading user content. Mirrors the Python
 * `Gemma._preprocess_request`.
 *
 * @param llmRequest The request to preprocess in place.
 */
export function preprocessGemmaRequest(llmRequest: LlmRequest): void {
  moveFunctionCallsIntoSystemInstruction(llmRequest);
  moveSystemInstructionToUserContent(llmRequest);
}

/**
 * Converts tool declarations and any function call / response history into a
 * text-based system instruction, then clears `config.tools`.
 *
 * @param llmRequest The request to transform in place.
 */
export function moveFunctionCallsIntoSystemInstruction(
  llmRequest: LlmRequest,
): void {
  const newContents: Content[] = [];
  for (const content of llmRequest.contents) {
    const {parts, hasFunctionResponse, hasFunctionCall} =
      convertContentPartsForGemma(content);

    if (hasFunctionResponse) {
      if (parts.length) {
        newContents.push({role: 'user', parts});
      }
    } else if (hasFunctionCall) {
      if (parts.length) {
        newContents.push({role: 'model', parts});
      }
    } else {
      newContents.push(content);
    }
  }
  llmRequest.contents = newContents;

  const config = llmRequest.config;
  if (!config?.tools?.length) {
    return;
  }

  const allFunctionDeclarations: FunctionDeclaration[] = [];
  for (const tool of config.tools) {
    if ('functionDeclarations' in tool && tool.functionDeclarations) {
      allFunctionDeclarations.push(...tool.functionDeclarations);
    }
  }

  if (allFunctionDeclarations.length) {
    const systemInstruction = buildGemmaFunctionSystemInstruction(
      allFunctionDeclarations,
    );
    appendInstructions(llmRequest, [systemInstruction]);
  }

  config.tools = [];
}

/**
 * Converts the function call / response parts of a single content into text
 * parts. Other parts are passed through unchanged.
 *
 * @param content The content whose parts should be converted.
 * @returns The converted parts and whether any function response / call part
 *   was encountered.
 */
export function convertContentPartsForGemma(content: Content): {
  parts: Part[];
  hasFunctionResponse: boolean;
  hasFunctionCall: boolean;
} {
  const parts: Part[] = [];
  let hasFunctionResponse = false;
  let hasFunctionCall = false;

  for (const part of content.parts ?? []) {
    if (part.functionResponse) {
      hasFunctionResponse = true;
      const {name, response} = part.functionResponse;
      parts.push(
        createPartFromText(
          `Invoking tool \`${name}\` produced: \`${JSON.stringify(response)}\`.`,
        ),
      );
    } else if (part.functionCall) {
      hasFunctionCall = true;
      parts.push(createPartFromText(JSON.stringify(part.functionCall)));
    } else {
      parts.push(part);
    }
  }

  return {parts, hasFunctionResponse, hasFunctionCall};
}

/**
 * Builds the text system instruction that teaches Gemma to emit function calls
 * as JSON, embedding the serialized tool declarations.
 *
 * @param functionDeclarations The declarations to advertise to the model.
 * @returns The system instruction, or an empty string when no declarations are
 *   supplied.
 */
export function buildGemmaFunctionSystemInstruction(
  functionDeclarations: FunctionDeclaration[],
): string {
  if (!functionDeclarations.length) {
    return '';
  }

  const declarations = functionDeclarations
    .map((declaration) => JSON.stringify(declaration))
    .join(',\n');

  return (
    `You have access to the following functions:\n[${declarations}\n]\n` +
    'When you call a function, you MUST respond in the format of: ' +
    '{"name": function name, "parameters": dictionary of argument name and its value}\n' +
    'When you call a function, you MUST NOT include any other text in the response.\n'
  );
}

/**
 * Hoists `config.systemInstruction` into a leading user-role content, since
 * Gemma 3 has no dedicated system instruction channel. The instruction is only
 * prepended when it is not already the first content (dedup), and is then
 * cleared from the config.
 *
 * @param llmRequest The request to transform in place.
 */
export function moveSystemInstructionToUserContent(
  llmRequest: LlmRequest,
): void {
  const systemInstruction = llmRequest.config?.systemInstruction as
    | string
    | undefined;
  if (!systemInstruction) {
    return;
  }

  const contents = llmRequest.contents;
  const instructionContent: Content = {
    role: 'user',
    parts: [createPartFromText(systemInstruction)],
  };

  // If history is preserved, include the system instruction exactly once at the
  // beginning of the chain of contents.
  if (
    contents.length &&
    !isInstructionContent(contents[0], systemInstruction)
  ) {
    llmRequest.contents = [instructionContent, ...contents];
  }

  llmRequest.config!.systemInstruction = undefined;
}

/**
 * Structural equality check mirroring pydantic's `Content.__eq__` for the
 * dedup case: a content equals the instruction iff it is a single user text
 * part carrying exactly the instruction text.
 */
function isInstructionContent(
  content: Content,
  systemInstruction: string,
): boolean {
  return (
    content.role === 'user' &&
    content.parts?.length === 1 &&
    content.parts[0].text === systemInstruction
  );
}

/**
 * Parses a Gemma text response and, when it encodes a single function call,
 * rewrites the response content into a structured `functionCall` part. Any
 * response that is streaming/partial, multi-part, empty, or not a valid
 * function-call JSON is left unchanged.
 *
 * @param llmResponse The response to transform in place.
 */
export function extractFunctionCallsFromResponse(
  llmResponse: LlmResponse,
): void {
  if (llmResponse.partial || llmResponse.turnComplete === true) {
    return;
  }
  if (!llmResponse.content?.parts?.length) {
    return;
  }
  if (llmResponse.content.parts.length > 1) {
    return;
  }

  const text = llmResponse.content.parts[0].text;
  if (!text) {
    return;
  }

  try {
    const blockMatch = MARKDOWN_CODE_BLOCK_PATTERN.exec(text);
    const jsonCandidate = blockMatch
      ? blockMatch[1].trim()
      : getLastValidJsonSubstring(text);
    if (!jsonCandidate) {
      return;
    }

    const functionCall = parseGemmaFunctionCall(JSON.parse(jsonCandidate));
    if (!functionCall) {
      return;
    }

    llmResponse.content.parts = [{functionCall}];
  } catch (e) {
    logger.debug(
      `Error attempting to parse JSON into function call. Leaving as text response. ${e}`,
    );
  }
}

/**
 * Finds the last balanced, valid JSON object substring in `text`, or `null`
 * when none is present. Scans each `{` and extracts a brace-balanced candidate
 * that respects string literals and escapes before validating it with
 * `JSON.parse`, keeping the last one that parses.
 *
 * @param text The text to search.
 * @returns The last valid JSON object substring, or `null`.
 */
export function getLastValidJsonSubstring(text: string): string | null {
  let lastJson: string | null = null;
  let searchStart = 0;

  while (searchStart < text.length) {
    const braceIndex = text.indexOf('{', searchStart);
    if (braceIndex === -1) {
      break;
    }

    const endIndex = findBalancedObjectEnd(text, braceIndex);
    if (endIndex !== -1) {
      const candidate = text.slice(braceIndex, endIndex + 1);
      try {
        JSON.parse(candidate);
        lastJson = candidate;
        searchStart = endIndex + 1;
        continue;
      } catch {
        // Balanced but not valid JSON; fall through and advance one character.
      }
    }

    searchStart = braceIndex + 1;
  }

  return lastJson;
}

/**
 * Returns the index of the `}` that closes the object opened at `start`, or
 * `-1` if the object is not brace-balanced. Braces inside string literals (with
 * escape handling) are ignored.
 */
function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * Parses an inline Gemma function call object with flexible key aliases,
 * accepting `name` or `function` for the function name and `parameters` or
 * `args` for the arguments. Returns `null` when either alias is missing or of
 * the wrong type.
 *
 * @param obj The parsed JSON value to interpret.
 * @returns The structured function call, or `null` when it is not a function
 *   call.
 */
export function parseGemmaFunctionCall(
  obj: unknown,
): {name: string; args: Record<string, unknown>} | null {
  if (typeof obj !== 'object' || obj === null) {
    return null;
  }

  const record = obj as Record<string, unknown>;
  const name = record['name'] ?? record['function'];
  const args = record['parameters'] ?? record['args'];

  if (typeof name !== 'string') {
    return null;
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return null;
  }

  return {name, args: args as Record<string, unknown>};
}
