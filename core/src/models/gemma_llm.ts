/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  createPartFromText,
  FunctionCall,
  FunctionDeclaration,
  Part,
} from '@google/genai';

import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

import {Gemini, GeminiParams} from './google_llm.js';
import {appendInstructions, LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/** The model used when the caller names none. */
const DEFAULT_GEMMA_MODEL = 'gemma-3-27b-it';

/** Prefix every model name this class accepts must carry. */
const GEMMA_MODEL_PREFIX = 'gemma-';

/**
 * Matches a fenced code block, optionally tagged `json` or `tool_code`, and
 * captures its body. `[\s\S]` stands in for Python's `re.DOTALL`, which
 * JavaScript regular expressions do not have.
 */
const MARKDOWN_CODE_BLOCK_PATTERN = /```(?:json|tool_code)?\s*([\s\S]*?)\s*```/;

/**
 * Integration for Gemma 3 models served by the Gemini API (Google AI Studio).
 *
 * Gemma 3 has neither native function calling nor a system instruction
 * channel, so this class applies three workarounds around the standard Gemini
 * transport:
 *
 * - Tool declarations become prompt text, and `config.tools` is emptied.
 * - Function call and function response history becomes plain text.
 * - The system instruction becomes a leading `user` content.
 *
 * A text response that encodes a function call is turned back into a
 * structured `functionCall` part, so the rest of ADK sees an ordinary tool
 * call.
 *
 * Gemma 4 and later need none of this. Use {@link Gemini} for them:
 *
 * ```ts
 * // Gemma 3: workarounds applied automatically.
 * const agent = new LlmAgent({
 *   name: 'assistant',
 *   model: new Gemma({model: 'gemma-3-27b-it'}),
 * });
 *
 * // Gemma 4+: native function calling.
 * const agent4 = new LlmAgent({
 *   name: 'assistant',
 *   model: new Gemini({model: 'gemma-4-31b-it'}),
 * });
 * ```
 *
 * For agentic use cases with Gemma 3, `gemma-3-27b-it` and `gemma-3-12b-it`
 * are strongly recommended. See https://ai.google.dev/gemma/docs/core/ .
 *
 * This class supports the Gemini API only; Vertex AI is not supported.
 */
export class Gemma extends Gemini {
  /**
   * @param params The parameters for creating a Gemma instance. `model`
   *   defaults to `gemma-3-27b-it`.
   */
  constructor(params: GeminiParams = {}) {
    super({...params, model: params.model ?? DEFAULT_GEMMA_MODEL});
  }

  /**
   * A list of model name patterns that are supported by this LLM.
   *
   * `gemma-4.*` is claimed by {@link Gemini}, which the registry registers
   * first, so Gemma 4 resolves to the native class instead of this one.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /gemma-.*/,
  ];

  /**
   * Gemma is served by the Gemini API only, so the backend is fixed and no
   * client is built to answer the question.
   */
  override get apiBackend(): GoogleLLMVariant {
    return GoogleLLMVariant.GEMINI_API;
  }

  /**
   * Sends a request to the Gemma model.
   *
   * @param llmRequest The request to send to the model.
   * @param stream Whether to do a streaming call.
   * @param abortSignal Signal that cancels the request.
   * @yields The model response.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const model = llmRequest.model ?? this.model;
    if (!model.startsWith(GEMMA_MODEL_PREFIX)) {
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
 * Applies every Gemma request workaround, in place.
 *
 * @param llmRequest The request to transform.
 */
export function preprocessGemmaRequest(llmRequest: LlmRequest): void {
  moveFunctionCallsIntoSystemInstruction(llmRequest);
  moveSystemInstructionToUserContent(llmRequest);
}

/**
 * Rewrites function call and function response history as text, describes the
 * declared tools in the system instruction, then empties `config.tools`.
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
      newContents.push({role: 'user', parts});
    } else if (hasFunctionCall) {
      newContents.push({role: 'model', parts});
    } else {
      newContents.push(content);
    }
  }
  llmRequest.contents = newContents;

  const config = llmRequest.config;
  if (!config?.tools?.length) {
    return;
  }

  const declarations: FunctionDeclaration[] = [];
  for (const tool of config.tools) {
    if ('functionDeclarations' in tool && tool.functionDeclarations) {
      declarations.push(...tool.functionDeclarations);
    }
  }

  if (declarations.length) {
    appendInstructions(llmRequest, [
      buildGemmaFunctionSystemInstruction(declarations),
    ]);
  }

  config.tools = [];
}

/**
 * Converts the function call and function response parts of one content into
 * text parts. Every other part passes through unchanged.
 *
 * @param content The content to convert.
 * @returns The converted parts, and which kinds of part were found.
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
          `Invoking tool \`${name}\` produced: \`${stringifyLikePython(response)}\`.`,
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
 * Builds the instruction that teaches Gemma to answer with a function call as
 * a JSON object.
 *
 * @param declarations The declarations to advertise to the model.
 * @returns The instruction, or an empty string when there are no declarations.
 */
export function buildGemmaFunctionSystemInstruction(
  declarations: FunctionDeclaration[],
): string {
  if (!declarations.length) {
    return '';
  }

  const serialized = declarations
    .map((declaration) => JSON.stringify(declaration))
    .join(',\n');

  return (
    `You have access to the following functions:\n[${serialized}\n]\n` +
    'When you call a function, you MUST respond in the format of: ' +
    '{"name": function name, "parameters": dictionary of argument name and its value}\n' +
    'When you call a function, you MUST NOT include any other text in the response.\n'
  );
}

/**
 * Hoists the system instruction into a leading `user` content, because Gemma 3
 * has no system instruction channel. Preserved history already starting with
 * that instruction is left alone, so the instruction cannot accumulate.
 *
 * @param llmRequest The request to transform in place.
 */
export function moveSystemInstructionToUserContent(
  llmRequest: LlmRequest,
): void {
  const config = llmRequest.config;
  if (!config) {
    return;
  }
  const instruction = config.systemInstruction;
  if (typeof instruction !== 'string' || !instruction) {
    return;
  }

  const contents = llmRequest.contents;
  if (contents.length && !isInstructionContent(contents[0], instruction)) {
    llmRequest.contents = [
      {role: 'user', parts: [createPartFromText(instruction)]},
      ...contents,
    ];
  }

  config.systemInstruction = undefined;
}

/**
 * Reports whether a content is the hoisted instruction itself: a single user
 * text part holding exactly that text. Stands in for the structural equality
 * adk-python gets from pydantic.
 */
function isInstructionContent(content: Content, instruction: string): boolean {
  return (
    content.role === 'user' &&
    content.parts?.length === 1 &&
    content.parts[0].text === instruction
  );
}

/**
 * Replaces a text response that encodes a function call with a structured
 * `functionCall` part. A partial chunk, a turn-complete marker, a multi-part
 * response and text that is not a function call are all left unchanged.
 *
 * A malformed response degrades to text; this function never throws.
 *
 * @param llmResponse The response to transform in place.
 */
export function extractFunctionCallsFromResponse(
  llmResponse: LlmResponse,
): void {
  if (llmResponse.partial || llmResponse.turnComplete === true) {
    return;
  }

  const content = llmResponse.content;
  if (!content?.parts || content.parts.length !== 1) {
    return;
  }

  const text = content.parts[0].text;
  if (!text) {
    return;
  }

  const blockMatch = MARKDOWN_CODE_BLOCK_PATTERN.exec(text);
  const candidate = blockMatch
    ? blockMatch[1].trim()
    : getLastValidJsonSubstring(text);
  if (!candidate) {
    return;
  }

  try {
    const functionCall = toGemmaFunctionCall(JSON.parse(candidate));
    if (!functionCall) {
      logger.debug(
        'Response JSON is not a Gemma function call. Leaving as text response.',
      );
      return;
    }
    content.parts = [{functionCall}];
  } catch (e: unknown) {
    if (e instanceof SyntaxError) {
      logger.debug(
        `Error attempting to parse JSON into function call. Leaving as text response. ${formatError(e)}`,
      );
      return;
    }
    logger.warn(
      `Error processing Gemma function call response: ${formatError(e)}`,
    );
  }
}

/**
 * Finds the last valid JSON object in a text, or `null` when there is none.
 *
 * adk-python uses `json.JSONDecoder().raw_decode`, which JavaScript has no
 * equivalent of, so each `{` starts a brace-depth scan that skips braces
 * inside string literals and honours backslash escapes.
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

    const endIndex = findObjectEnd(text, braceIndex);
    const candidate =
      endIndex === -1 ? null : text.slice(braceIndex, endIndex + 1);
    if (candidate !== null && isParsableJson(candidate)) {
      lastJson = candidate;
      searchStart = endIndex + 1;
    } else {
      searchStart = braceIndex + 1;
    }
  }

  return lastJson;
}

/**
 * Returns the index of the `}` that closes the object opened at `start`, or
 * `-1` when the object never closes.
 */
function findObjectEnd(text: string, start: number): number {
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
    } else if (char === '"') {
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

/** Reports whether a text parses as JSON. */
function isParsableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads an inline Gemma function call. adk-python accepts two aliases per
 * field, so `name` or `function` names the function, and `parameters` or
 * `args` holds the arguments.
 *
 * @param value The parsed JSON value to read.
 * @returns The function call, or `null` when the value is not one.
 */
function toGemmaFunctionCall(value: unknown): FunctionCall | null {
  if (!isRecord(value)) {
    return null;
  }
  const name = value['name'] ?? value['function'];
  const args = value['parameters'] ?? value['args'];
  if (typeof name !== 'string' || !isRecord(args)) {
    return null;
  }
  return {name, args};
}

/** Narrows a value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Serializes a value the way Python's `json.dumps` does, with a space after
 * every `:` and `,`. The result is prompt text the model reads, so it matches
 * adk-python character for character; `JSON.stringify` writes no such spaces.
 */
function stringifyLikePython(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stringifyLikePython).join(', ')}]`;
  }
  if (isRecord(value)) {
    const fields = Object.entries(value)
      .filter(([, fieldValue]) => fieldValue !== undefined)
      .map(
        ([key, fieldValue]) =>
          `${JSON.stringify(key)}: ${stringifyLikePython(fieldValue)}`,
      );
    return `{${fields.join(', ')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
