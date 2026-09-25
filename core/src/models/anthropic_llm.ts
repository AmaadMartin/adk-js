/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type Anthropic from '@anthropic-ai/sdk';
import {AnthropicVertex} from '@anthropic-ai/vertex-sdk';
import {Content, FinishReason, FunctionDeclaration, Part} from '@google/genai';

import {contentUnionToText} from '../utils/content_utils.js';
import {logger} from '../utils/logger.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * The maximum number of tokens Claude may generate for one response.
 */
export const MAX_TOKEN = 1024;

const DEFAULT_CLAUDE_MODEL = 'claude-3-5-sonnet-v2@20241022';

type ClaudeMessageBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam;

/**
 * Parameters for creating a {@link Claude} instance.
 */
export interface ClaudeParams {
  /**
   * The Claude model on Vertex AI, e.g. `claude-3-5-sonnet-v2@20241022`.
   */
  model?: string;
}

/**
 * Maps a Gemini content role to the corresponding Claude message role.
 */
export function toClaudeRole(role?: string): 'user' | 'assistant' {
  if (role === 'model' || role === 'assistant') {
    return 'assistant';
  }
  return 'user';
}

/**
 * Maps a Claude stop reason to the corresponding Gemini finish reason.
 */
export function toGoogleGenaiFinishReason(
  anthropicStopReason?: string | null,
): FinishReason {
  switch (anthropicStopReason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
      return FinishReason.STOP;
    case 'max_tokens':
      return FinishReason.MAX_TOKENS;
    default:
      return FinishReason.FINISH_REASON_UNSPECIFIED;
  }
}

/**
 * Converts a Gemini part into a Claude message content block.
 *
 * Supports text, function call and function response parts.
 */
export function partToMessageBlock(part: Part): ClaudeMessageBlock {
  if (part.text) {
    return {text: part.text, type: 'text'};
  }
  if (part.functionCall) {
    if (!part.functionCall.name) {
      throw new Error('Function call part must have a name.');
    }
    return {
      id: part.functionCall.id ?? '',
      name: part.functionCall.name,
      input: part.functionCall.args ?? {},
      type: 'tool_use',
    };
  }
  if (part.functionResponse) {
    const result = part.functionResponse.response?.['result'];
    // Claude tool results accept text content only, so structured results
    // are serialized rather than rejected by the API.
    const content = result
      ? typeof result === 'string'
        ? result
        : JSON.stringify(result)
      : '';
    return {
      tool_use_id: part.functionResponse.id ?? '',
      type: 'tool_result',
      content,
      is_error: false,
    };
  }
  throw new Error('Not supported yet.');
}

/**
 * Converts a Gemini content into a Claude message.
 */
export function contentToMessageParam(
  content: Content,
): Anthropic.MessageParam {
  return {
    role: toClaudeRole(content.role),
    content: (content.parts ?? []).map(partToMessageBlock),
  };
}

/**
 * Converts a Claude response content block into a Gemini part.
 *
 * Supports text and tool use blocks.
 */
export function contentBlockToPart(contentBlock: Anthropic.ContentBlock): Part {
  switch (contentBlock.type) {
    case 'text':
      return {text: contentBlock.text};
    case 'tool_use':
      if (!isRecord(contentBlock.input)) {
        throw new Error('Tool use input must be an object.');
      }
      return {
        functionCall: {
          id: contentBlock.id,
          name: contentBlock.name,
          args: contentBlock.input,
        },
      };
    default:
      throw new Error('Not supported yet.');
  }
}

/**
 * Converts a Claude message into an {@link LlmResponse}.
 */
export function messageToGenerateContentResponse(
  message: Anthropic.Message,
): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: message.content.map(contentBlockToPart),
    },
  };
}

/**
 * Converts a Gemini function declaration into a Claude tool definition.
 *
 * Top-level property types are lowercased because Claude expects JSON Schema
 * type names (`string`) rather than Gemini enum values (`STRING`).
 */
export function functionDeclarationToToolParam(
  functionDeclaration: FunctionDeclaration,
): Anthropic.Tool {
  if (!functionDeclaration.name) {
    throw new Error('Function declaration must have a name.');
  }

  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    functionDeclaration.parameters?.properties ?? {},
  )) {
    properties[key] = value.type
      ? {...value, type: value.type.toLowerCase()}
      : {...value};
  }

  return {
    name: functionDeclaration.name,
    description: functionDeclaration.description ?? '',
    input_schema: {
      type: 'object',
      properties,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Integration for Claude models served through Anthropic on Vertex AI.
 *
 * Requires the `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` environment
 * variables to be set.
 */
export class Claude extends BaseLlm {
  private client?: AnthropicVertex;

  /**
   * A list of model name patterns that are supported by this LLM.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /claude-3-.*/,
  ];

  constructor({model = DEFAULT_CLAUDE_MODEL}: ClaudeParams = {}) {
    super({model});
  }

  /**
   * Sends the request to Claude and yields a single response.
   *
   * Streaming is not supported; `stream` is ignored.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const messages = llmRequest.contents.map(contentToMessageParam);

    const firstTool = llmRequest.config?.tools?.[0];
    const functionDeclarations =
      firstTool && 'functionDeclarations' in firstTool
        ? firstTool.functionDeclarations
        : undefined;
    const tools = functionDeclarations?.length
      ? functionDeclarations.map(functionDeclarationToToolParam)
      : undefined;

    const toolChoice: Anthropic.ToolChoiceAuto | undefined =
      Object.keys(llmRequest.toolsDict).length > 0
        ? {type: 'auto', disable_parallel_tool_use: true}
        : undefined;

    const systemInstruction = llmRequest.config?.systemInstruction;

    const message = await this.anthropicClient.messages.create(
      {
        model: llmRequest.model ?? this.model,
        system:
          systemInstruction === undefined
            ? undefined
            : contentUnionToText(systemInstruction),
        messages,
        tools,
        tool_choice: toolChoice,
        max_tokens: MAX_TOKEN,
      },
      {signal: abortSignal},
    );
    logger.debug(
      `Claude response received: ${message.content.length} content blocks, stop reason ${message.stop_reason}`,
    );
    yield messageToGenerateContentResponse(message);
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(`Live connection is not supported for ${this.model}.`);
  }

  private get anthropicClient(): AnthropicVertex {
    if (!this.client) {
      const projectId = process.env['GOOGLE_CLOUD_PROJECT'];
      const region = process.env['GOOGLE_CLOUD_LOCATION'];
      if (projectId === undefined || region === undefined) {
        throw new Error(
          'GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION must be set for using Anthropic on Vertex.',
        );
      }
      this.client = new AnthropicVertex({projectId, region});
    }
    return this.client;
  }
}
