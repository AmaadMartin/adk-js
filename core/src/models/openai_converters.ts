/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conversions between the genai types ADK speaks and the OpenAI Chat
 * Completions wire format.
 *
 * Ported from adk-python `src/google/adk/labs/openai/_openai_llm.py`.
 */

import {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  Part,
  Schema,
  Type,
} from '@google/genai';
import type {OpenAI} from 'openai';

import {genaiSchemaToJsonSchema} from '../utils/genai_schema_to_json.js';
import {logger} from '../utils/logger.js';

import {extractSystemInstruction} from './interactions_utils.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';
import {
  enforceStrictOpenAiSchema,
  isJsonSchemaObject,
  JsonSchemaObject,
  lowercaseSchemaTypes,
} from './openai_schema.js';

/** Name given to a strict `json_schema` response format with no `title`. */
const DEFAULT_RESPONSE_SCHEMA_NAME = 'response';

/** The genai `type` values, used to tell a genai `Schema` from JSON Schema. */
const GENAI_SCHEMA_TYPES = new Set<string>(Object.values(Type));

/** A single accumulated tool call, assembled from streamed fragments. */
interface AccumulatedToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

/** Maps a genai content role onto the OpenAI message role. */
export function toOpenAiRole(
  role: string | undefined,
): 'system' | 'user' | 'assistant' | 'tool' {
  switch (role) {
    case 'model':
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool':
      return 'tool';
    default:
      return 'user';
  }
}

/**
 * Converts a genai `Part` into OpenAI content.
 *
 * @param part The part to convert.
 * @return The part's text, an `image_url` content part, or `''` for a part
 *   OpenAI has no representation for.
 */
export function partToOpenAiContent(
  part: Part,
): string | OpenAI.Chat.ChatCompletionContentPartImage {
  if (part.thought && part.text) {
    return `Thought: ${part.text}`;
  }
  if (part.text) {
    return part.text;
  }
  if (part.inlineData) {
    const {mimeType, data} = part.inlineData;
    return {
      type: 'image_url',
      image_url: {url: `data:${mimeType};base64,${data ?? ''}`},
    };
  }
  if (part.fileData?.fileUri?.startsWith('http')) {
    return {type: 'image_url', image_url: {url: part.fileData.fileUri}};
  }
  return '';
}

/**
 * Converts one genai `Content` into the OpenAI messages it produces.
 *
 * A content holding function responses becomes one `tool` message per
 * response; everything else becomes at most one message. Content that mixes
 * text and images is sent as a multipart array, and text-only content is
 * joined into a single string, which is what OpenAI-compatible hosts expect.
 *
 * @param content The genai content to convert.
 * @return The OpenAI messages, possibly empty.
 */
export function contentToOpenAiMessages(
  content: Content,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const role = toOpenAiRole(content.role);
  const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
  const contentParts: Array<
    | OpenAI.Chat.ChatCompletionContentPartText
    | OpenAI.Chat.ChatCompletionContentPartImage
  > = [];

  for (const part of content.parts ?? []) {
    if (part.functionCall) {
      toolCalls.push({
        id: part.functionCall.id ?? '',
        type: 'function',
        function: {
          name: part.functionCall.name ?? '',
          arguments: part.functionCall.args
            ? JSON.stringify(part.functionCall.args)
            : '{}',
        },
      });
    } else if (part.functionResponse) {
      messages.push({
        role: 'tool',
        tool_call_id: part.functionResponse.id ?? '',
        content:
          part.functionResponse.response !== undefined
            ? JSON.stringify(part.functionResponse.response)
            : '',
      });
    } else {
      const converted = partToOpenAiContent(part);
      if (typeof converted === 'string') {
        if (converted) {
          contentParts.push({type: 'text', text: converted});
        }
      } else {
        contentParts.push(converted);
      }
    }
  }

  const hasImages = contentParts.some((part) => part.type === 'image_url');
  const text = joinTextParts(contentParts);

  if (role === 'assistant' && (text || toolCalls.length > 0)) {
    // The API accepts no image on an assistant message, so assistant content
    // is always its text.
    const message: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: 'assistant',
    };
    if (text) {
      message.content = text;
    }
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }
    messages.push(message);
  } else if (role === 'user' && (text || hasImages)) {
    messages.push({role: 'user', content: hasImages ? contentParts : text});
  } else if (role === 'system' && text) {
    messages.push({role: 'system', content: text});
  }

  return messages;
}

/** Joins the text of every text content part with newlines. */
function joinTextParts(
  parts: Array<
    | OpenAI.Chat.ChatCompletionContentPartText
    | OpenAI.Chat.ChatCompletionContentPartImage
  >,
): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/**
 * Converts a genai `FunctionDeclaration` into an OpenAI tool.
 *
 * @param functionDeclaration The declaration to convert.
 * @return The OpenAI tool.
 * @throws If the declaration has no name.
 */
export function functionDeclarationToOpenAiTool(
  functionDeclaration: FunctionDeclaration,
): OpenAI.Chat.ChatCompletionFunctionTool {
  if (!functionDeclaration.name) {
    throw new Error('FunctionDeclaration must have a name.');
  }

  const parameters = functionDeclaration.parametersJsonSchema
    ? (structuredClone(
        functionDeclaration.parametersJsonSchema,
      ) as JsonSchemaObject)
    : declaredParametersToJsonSchema(functionDeclaration.parameters);
  lowercaseSchemaTypes(parameters);

  return {
    type: 'function',
    function: {
      name: functionDeclaration.name,
      description: functionDeclaration.description ?? '',
      parameters,
    },
  };
}

/**
 * Returns the function declarations of a request's first tool entry.
 *
 * Only the first entry is read, matching the reference implementation. A
 * `CallableTool` declares no functions inline and yields none.
 */
function declaredFunctions(
  config: GenerateContentConfig | undefined,
): FunctionDeclaration[] {
  const tool = config?.tools?.[0];
  if (tool && 'functionDeclarations' in tool) {
    return tool.functionDeclarations ?? [];
  }
  return [];
}

/** Renders a genai parameter `Schema` as an OpenAI `parameters` object. */
function declaredParametersToJsonSchema(
  schema: Schema | undefined,
): JsonSchemaObject {
  const properties: JsonSchemaObject = {};
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    properties[name] = genaiSchemaToJsonSchema(property);
  }

  const parameters: JsonSchemaObject = {type: 'object', properties};
  if (schema?.required?.length) {
    parameters['required'] = schema.required;
  }
  return parameters;
}

/**
 * Converts a non-streamed completion into an `LlmResponse`.
 *
 * @param completion The completion returned by the API.
 * @return The response, carrying a text part followed by one function-call
 *   part per tool call.
 */
export function completionToLlmResponse(
  completion: OpenAI.Chat.ChatCompletion,
): LlmResponse {
  const message = completion.choices[0]?.message;
  const parts: Part[] = [];

  if (message?.content) {
    parts.push({text: message.content});
  }
  for (const toolCall of message?.tool_calls ?? []) {
    if (toolCall.type !== 'function') {
      continue;
    }
    parts.push({
      functionCall: {
        id: toolCall.id,
        name: toolCall.function.name,
        args: parseToolCallArguments(
          toolCall.function.arguments,
          'Failed to parse tool call arguments as JSON.',
        ),
      },
    });
  }

  const usage = completion.usage;
  return {
    content: {role: 'model', parts},
    usageMetadata: {
      promptTokenCount: usage?.prompt_tokens,
      candidatesTokenCount: usage?.completion_tokens,
      totalTokenCount: usage?.total_tokens,
      cachedContentTokenCount: usage?.prompt_tokens_details?.cached_tokens,
    },
  };
}

/**
 * Converts a streamed completion into responses.
 *
 * Every text delta is emitted on its own as a partial response. Tool-call
 * fragments cannot be, because their arguments arrive in pieces, so they are
 * accumulated by index and emitted in one final response together with the
 * full text.
 *
 * @param chunks The stream returned by the API.
 * @return Partial responses per text delta, then one final response.
 */
export async function* streamToLlmResponses(
  chunks: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
): AsyncGenerator<LlmResponse, void> {
  let text = '';
  const toolCalls = new Map<number, AccumulatedToolCall>();

  for await (const chunk of chunks) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) {
      continue;
    }

    if (delta.content) {
      text += delta.content;
      yield {
        content: {role: 'model', parts: [{text: delta.content}]},
        partial: true,
      };
    }

    for (const fragment of delta.tool_calls ?? []) {
      const accumulated = toolCalls.get(fragment.index) ?? {
        id: fragment.id,
        name: fragment.function?.name,
        arguments: '',
      };
      accumulated.arguments += fragment.function?.arguments ?? '';
      toolCalls.set(fragment.index, accumulated);
    }
  }

  const parts: Part[] = [];
  if (text) {
    parts.push({text});
  }
  for (const [, accumulated] of [...toolCalls].sort(([a], [b]) => a - b)) {
    parts.push({
      functionCall: {
        id: accumulated.id,
        name: accumulated.name,
        args: parseToolCallArguments(
          accumulated.arguments,
          'Failed to parse accumulated tool call arguments as JSON.',
        ),
      },
    });
  }

  yield {content: {role: 'model', parts}, partial: false};
}

/** Parses tool-call arguments, warning and falling back to `{}` on garbage. */
function parseToolCallArguments(
  args: string | undefined,
  warning: string,
): Record<string, unknown> {
  if (!args) {
    return {};
  }
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    logger.warn(warning);
    return {};
  }
}

/**
 * Builds the OpenAI `response_format` for a request.
 *
 * @param config The request's generation config.
 * @return A strict `json_schema` format when the request declares a response
 *   schema, `json_object` when it only asks for JSON, `undefined` otherwise.
 */
export function toOpenAiResponseFormat(
  config: GenerateContentConfig | undefined,
):
  | OpenAI.ResponseFormatJSONSchema
  | OpenAI.ResponseFormatJSONObject
  | undefined {
  const responseSchema = config?.responseSchema;
  if (isJsonSchemaObject(responseSchema)) {
    const schema = toStrictJsonSchema(responseSchema);
    const title = schema['title'];
    return {
      type: 'json_schema',
      json_schema: {
        name: typeof title === 'string' ? title : DEFAULT_RESPONSE_SCHEMA_NAME,
        strict: true,
        schema,
      },
    };
  }
  if (config?.responseMimeType === 'application/json') {
    return {type: 'json_object'};
  }
  return undefined;
}

/**
 * Converts a response schema into the strict JSON Schema OpenAI wants.
 *
 * genai types `responseSchema` as `Schema | unknown`, so both a genai `Schema`
 * and a plain JSON Schema object reach here. A genai `Schema` is recognised by
 * its uppercase `type` and converted, which also unwraps `nullable` and the
 * stringified bounds; anything else is only case-normalised, because
 * converting it would drop its already-lowercase `type`.
 */
function toStrictJsonSchema(
  responseSchema: JsonSchemaObject,
): JsonSchemaObject {
  let schema: JsonSchemaObject;
  if (
    typeof responseSchema['type'] === 'string' &&
    GENAI_SCHEMA_TYPES.has(responseSchema['type'])
  ) {
    schema = genaiSchemaToJsonSchema(responseSchema as Schema);
  } else {
    schema = structuredClone(responseSchema);
    lowercaseSchemaTypes(schema);
  }
  enforceStrictOpenAiSchema(schema);
  return schema;
}

/**
 * Builds the parameters for a Chat Completions call.
 *
 * @param llmRequest The ADK request to translate.
 * @param model The model to call.
 * @param maxTokens The token ceiling to apply when the request sets none.
 * @return The non-streaming create parameters.
 */
export function buildCreateParams(
  llmRequest: LlmRequest,
  model: string,
  maxTokens: number,
): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
  const config = llmRequest.config;
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  const systemInstruction = config && extractSystemInstruction(config);
  if (systemInstruction) {
    messages.push({role: 'system', content: systemInstruction});
  }
  for (const content of llmRequest.contents) {
    messages.push(...contentToOpenAiMessages(content));
  }

  const tools = declaredFunctions(config).map(functionDeclarationToOpenAiTool);

  const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    max_tokens: config?.maxOutputTokens ?? maxTokens,
  };

  if (tools.length > 0) {
    params.tools = tools;
    params.tool_choice = 'auto';
  }
  const responseFormat = toOpenAiResponseFormat(config);
  if (responseFormat) {
    params.response_format = responseFormat;
  }
  if (config?.temperature !== undefined) {
    params.temperature = config.temperature;
  }
  if (config?.topP !== undefined) {
    params.top_p = config.topP;
  }
  if (config?.stopSequences?.length) {
    params.stop = config.stopSequences;
  }

  return params;
}
