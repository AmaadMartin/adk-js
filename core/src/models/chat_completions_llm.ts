/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  Content,
  ContentUnion,
  createPartFromText,
  FinishReason,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  Part,
  Tool,
} from '@google/genai';

import {logger} from '../utils/logger.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

/**
 * Prefix used to mark model refusals within accumulated text content. Mirrors
 * the OpenAI Chat Completions `refusal` field, which has no direct `Content`
 * equivalent in `@google/genai`.
 */
const REFUSAL_PREFIX = '[[REFUSAL]]: ';

/**
 * Top-level response fields copied verbatim into `LlmResponse.customMetadata`.
 */
const CUSTOM_METADATA_FIELDS = [
  'id',
  'created',
  'model',
  'service_tier',
  'object',
] as const;

/**
 * Parameters for constructing a {@link ChatCompletionsLlm}.
 */
export interface ChatCompletionsLlmParams {
  /**
   * Base URL of the OpenAI-compatible server, e.g.
   * 'http://localhost:11434/v1'. '/chat/completions' is appended if not already
   * present.
   */
  baseURL: string;
  /** Model name sent as the payload `model`, e.g. 'llama3.1'. */
  model: string;
  /** Optional API key; when set, sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Optional extra headers merged into every request. */
  headers?: Record<string, string>;
  /**
   * Optional provider hint. When it indicates Ollama (e.g. 'ollama' /
   * 'ollama_chat'), text-only multipart message content is flattened to a
   * single newline-joined string, because Ollama's chat endpoint rejects
   * arrays for text-only `content`.
   */
  provider?: string;
}

/**
 * A `BaseLlm` implementation that speaks the OpenAI Chat Completions wire
 * format (`POST {baseURL}/chat/completions`) over the platform-native `fetch`.
 *
 * One class serves any OpenAI-compatible server (Ollama, vLLM, LM Studio,
 * etc.). Because a base URL is always required, instances are constructed
 * directly and handed to an `LlmAgent`; they are never auto-registered by
 * model prefix.
 */
export class ChatCompletionsLlm extends BaseLlm {
  /** Never auto-registered: a base URL is required to instantiate. */
  static override readonly supportedModels: Array<string | RegExp> = [];

  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;
  private readonly provider?: string;

  constructor(params: ChatCompletionsLlmParams) {
    super({model: params.model});
    this.baseURL = params.baseURL;
    this.apiKey = params.apiKey;
    this.headers = params.headers ?? {};
    this.provider = params.provider;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.maybeAppendUserContent(llmRequest);

    const model = llmRequest.model ?? this.model;
    const headers: Record<string, string> = {
      ...this.headers,
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(buildUrl(this.baseURL), {
      method: 'POST',
      headers,
      body: JSON.stringify(
        buildPayload(llmRequest, model, stream, this.provider),
      ),
      signal: abortSignal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `ChatCompletionsLlm request to ${model} failed with status ` +
          `${response.status}: ${body}`,
      );
    }

    if (stream) {
      yield* handleStreaming(response);
      return;
    }

    const handler = new ChatCompletionsResponseHandler();
    yield handler.processResponse(
      (await response.json()) as Record<string, unknown>,
    );
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'ChatCompletionsLlm does not support live connections (connect). Use ' +
        'generateContentAsync.',
    );
  }
}

/**
 * Resolves the full chat-completions URL from a base URL, appending
 * '/chat/completions' unless it is already present.
 */
function buildUrl(baseURL: string): string {
  if (baseURL.endsWith('/chat/completions')) {
    return baseURL;
  }
  return `${baseURL.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * Constructs the Chat Completions request payload from an `LlmRequest`.
 */
function buildPayload(
  llmRequest: LlmRequest,
  model: string,
  stream: boolean,
  provider?: string,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const config = llmRequest.config;

  if (config?.systemInstruction) {
    const content = serializeSystemInstruction(config.systemInstruction);
    if (content) {
      messages.push({role: 'system', content});
    }
  }

  for (const content of llmRequest.contents) {
    messages.push(...contentToMessages(content, provider));
  }

  const payload: Record<string, unknown> = {model, messages, stream};
  if (config) {
    mapConfigParameters(config, payload);
    mapTools(config, payload);
  }
  return payload;
}

/**
 * Maps generation config parameters onto the payload, only when defined.
 */
function mapConfigParameters(
  config: GenerateContentConfig,
  payload: Record<string, unknown>,
): void {
  if (config.temperature !== undefined) {
    payload['temperature'] = config.temperature;
  }
  if (config.topP !== undefined) {
    payload['top_p'] = config.topP;
  }
  if (config.maxOutputTokens !== undefined) {
    payload['max_tokens'] = config.maxOutputTokens;
  }
  if (config.stopSequences?.length) {
    payload['stop'] = config.stopSequences;
  }
  if (config.frequencyPenalty !== undefined) {
    payload['frequency_penalty'] = config.frequencyPenalty;
  }
  if (config.presencePenalty !== undefined) {
    payload['presence_penalty'] = config.presencePenalty;
  }
  if (config.seed !== undefined) {
    payload['seed'] = config.seed;
  }
  if (config.candidateCount !== undefined) {
    payload['n'] = config.candidateCount;
  }
  if (config.responseLogprobs) {
    payload['logprobs'] = true;
    if (config.logprobs !== undefined) {
      payload['top_logprobs'] = config.logprobs;
    }
  }

  if (config.responseJsonSchema) {
    payload['response_format'] = {
      type: 'json_schema',
      json_schema: config.responseJsonSchema,
    };
  } else if (config.responseMimeType === 'application/json') {
    payload['response_format'] = {type: 'json_object'};
  }
}

/**
 * Maps tool declarations and tool-choice mode onto the payload.
 */
function mapTools(
  config: GenerateContentConfig,
  payload: Record<string, unknown>,
): void {
  if (!config.tools) {
    return;
  }

  const tools: Array<Record<string, unknown>> = [];
  for (const tool of config.tools) {
    const declarations = (tool as Tool).functionDeclarations;
    if (declarations) {
      for (const func of declarations) {
        tools.push(functionDeclarationToTool(func));
      }
    }
  }
  if (!tools.length) {
    return;
  }

  payload['tools'] = tools;
  const mode = config.toolConfig?.functionCallingConfig?.mode;
  if (mode === FunctionCallingConfigMode.ANY) {
    payload['tool_choice'] = 'required';
  } else if (mode === FunctionCallingConfigMode.NONE) {
    payload['tool_choice'] = 'none';
  } else if (mode === FunctionCallingConfigMode.AUTO) {
    payload['tool_choice'] = 'auto';
  }
}

/**
 * Converts a `FunctionDeclaration` to an OpenAI tool object.
 */
function functionDeclarationToTool(
  func: FunctionDeclaration,
): Record<string, unknown> {
  const parameters: unknown =
    func.parametersJsonSchema ?? func.parameters ?? {};
  return {
    type: 'function',
    function: {
      name: func.name,
      description: func.description,
      parameters,
    },
  };
}

/**
 * Serializes a system instruction (`string`, `Part`, `Content`, or an array of
 * those) down to a single string by joining all text.
 */
function serializeSystemInstruction(instruction: ContentUnion): string {
  if (typeof instruction === 'string') {
    return instruction;
  }
  if (Array.isArray(instruction)) {
    return instruction
      .map((item) => (typeof item === 'string' ? item : (item.text ?? '')))
      .join('');
  }
  // Either a Content (has `parts`) or a single Part (has `text`).
  const single: {parts?: Part[]; text?: string} = instruction;
  if (single.parts) {
    return single.parts.map((part) => part.text ?? '').join('');
  }
  return single.text ?? '';
}

/**
 * Converts a `Content` into one or more Chat Completions messages.
 *
 * Function responses are emitted as separate `tool` messages; when any are
 * present, only those are returned (mirroring the reference behavior).
 */
function contentToMessages(
  content: Content,
  provider?: string,
): Array<Record<string, unknown>> {
  const role = content.role === 'model' ? 'assistant' : content.role;

  const toolCalls: Array<Record<string, unknown>> = [];
  const contentParts: Array<Record<string, unknown>> = [];
  const refusals: string[] = [];
  const functionResponses: Array<Record<string, unknown>> = [];

  for (const part of content.parts ?? []) {
    processContentPart(content, part, toolCalls, contentParts, refusals);
    if (part.functionResponse) {
      functionResponses.push({
        role: 'tool',
        tool_call_id: part.functionResponse.id,
        content: JSON.stringify(part.functionResponse.response),
      });
    }
  }

  if (functionResponses.length) {
    return functionResponses;
  }

  const message: Record<string, unknown> = {role};
  if (refusals.length) {
    message['refusal'] = refusals.join('\n');
  }
  if (toolCalls.length) {
    message['tool_calls'] = toolCalls;
    if (!contentParts.length) {
      message['content'] = null;
    }
  }
  if (contentParts.length) {
    const singleText =
      contentParts.length === 1 && contentParts[0]['type'] === 'text';
    let messageContent: unknown = singleText
      ? contentParts[0]['text']
      : contentParts;
    if (isOllamaProvider(provider)) {
      messageContent = flattenOllamaContent(messageContent);
    }
    message['content'] = messageContent;
  }
  return [message];
}

/**
 * Processes a single `Part`, appending to `toolCalls`, `contentParts`, or
 * `refusals`. Function responses are handled by the caller.
 */
function processContentPart(
  content: Content,
  part: Part,
  toolCalls: Array<Record<string, unknown>>,
  contentParts: Array<Record<string, unknown>>,
  refusals: string[],
): void {
  const isImage =
    !!part.inlineData || !!part.fileData?.mimeType?.startsWith('image');
  if (content.role !== 'user' && isImage) {
    logger.warn('Image data is not supported for assistant turns.');
    return;
  }

  if (part.functionCall) {
    const fc = part.functionCall;
    const toolCall: Record<string, unknown> = {
      id: fc.id || 'call_' + fc.name,
      type: 'function',
      function: {
        name: fc.name,
        arguments: JSON.stringify(fc.args ?? {}),
      },
    };
    if (part.thoughtSignature) {
      toolCall['extra_content'] = {
        google: {thought_signature: part.thoughtSignature},
      };
    }
    toolCalls.push(toolCall);
  } else if (part.text) {
    if (part.text.startsWith(REFUSAL_PREFIX)) {
      refusals.push(part.text.slice(REFUSAL_PREFIX.length));
    } else {
      const separator = '\n' + REFUSAL_PREFIX;
      const index = part.text.indexOf(separator);
      const before = index === -1 ? part.text : part.text.slice(0, index);
      if (index !== -1) {
        refusals.push(part.text.slice(index + separator.length));
      }
      if (before) {
        contentParts.push({type: 'text', text: before});
      }
    }
  } else if (part.inlineData) {
    const {mimeType, data} = part.inlineData;
    contentParts.push({
      type: 'image_url',
      image_url: {url: `data:${mimeType};base64,${data}`},
    });
  } else if (part.fileData) {
    if (part.fileData.fileUri) {
      contentParts.push({
        type: 'image_url',
        image_url: {url: part.fileData.fileUri},
      });
    }
  } else if (part.executableCode) {
    logger.warn(
      'Executable code is not supported in the standard Chat Completions API.',
    );
  } else if (part.codeExecutionResult) {
    logger.warn(
      'Code execution result is not supported in the standard Chat ' +
        'Completions API.',
    );
  }
}

/**
 * Returns true when the provider hint indicates an Ollama chat endpoint.
 */
function isOllamaProvider(provider?: string): boolean {
  return !!provider && provider.trim().toLowerCase().startsWith('ollama');
}

/**
 * Flattens text-only multipart content into a single newline-joined string for
 * Ollama, which rejects arrays for text-only `content`. Content containing
 * media blocks (e.g. image_url) is returned unchanged.
 *
 * simplicity: content parts produced here are only `text` or `image_url`, so a
 * non-`text` block is treated as media. Upgrade to an explicit media-type set
 * if video/audio content parts are ever emitted.
 */
function flattenOllamaContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  const blocks = content as Array<Record<string, unknown>>;
  if (blocks.some((block) => block['type'] !== 'text')) {
    return blocks;
  }
  return blocks.map((block) => block['text']).join('\n');
}

/**
 * Maps an OpenAI `finish_reason` to a `@google/genai` `FinishReason`.
 */
function mapFinishReason(reason: unknown): FinishReason {
  switch (reason) {
    case 'stop':
      return FinishReason.STOP;
    case 'length':
      return FinishReason.MAX_TOKENS;
    case 'tool_calls':
      return FinishReason.STOP;
    case 'content_filter':
      return FinishReason.SAFETY;
    default:
      return FinishReason.FINISH_REASON_UNSPECIFIED;
  }
}

/**
 * Builds usage metadata from an OpenAI `usage` object.
 */
function buildUsageMetadata(
  usage: Record<string, unknown>,
): GenerateContentResponseUsageMetadata {
  const metadata: GenerateContentResponseUsageMetadata = {
    promptTokenCount: (usage['prompt_tokens'] as number) ?? 0,
    candidatesTokenCount: (usage['completion_tokens'] as number) ?? 0,
    totalTokenCount: (usage['total_tokens'] as number) ?? 0,
  };
  const details = usage['completion_tokens_details'] as
    | Record<string, unknown>
    | undefined;
  const reasoningTokens = details?.['reasoning_tokens'] as number | undefined;
  if (reasoningTokens) {
    metadata.thoughtsTokenCount = reasoningTokens;
  }
  return metadata;
}

/**
 * Reads a streaming Chat Completions `Response` body, splitting the SSE stream
 * into lines and yielding an `LlmResponse` for each produced chunk.
 */
async function* handleStreaming(
  response: Response,
): AsyncGenerator<LlmResponse, void> {
  const body = response.body;
  if (!body) {
    return;
  }

  const handler = new ChatCompletionsResponseHandler();
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {stream: true});
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const result = parseStreamingLine(line, handler);
        if (result.done) {
          return;
        }
        yield* result.responses;
        newlineIndex = buffer.indexOf('\n');
      }
    }
    if (buffer) {
      const result = parseStreamingLine(buffer, handler);
      if (!result.done) {
        yield* result.responses;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Result of parsing a single streaming line: `done` signals `[DONE]` was seen.
 */
interface StreamingLineResult {
  done: boolean;
  responses: LlmResponse[];
}

/**
 * Parses one SSE line, stripping an optional `data:` prefix, detecting the
 * `[DONE]` sentinel, and feeding valid JSON chunks to the accumulator. A line
 * that fails to parse is logged and skipped (the stream is not aborted).
 */
function parseStreamingLine(
  rawLine: string,
  handler: ChatCompletionsResponseHandler,
): StreamingLineResult {
  if (!rawLine) {
    return {done: false, responses: []};
  }
  let line = rawLine.trim();
  if (line.startsWith('data:')) {
    line = line.slice('data:'.length).trimStart();
  }
  if (line === '[DONE]') {
    return {done: true, responses: []};
  }
  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(line) as Record<string, unknown>;
  } catch {
    logger.warn(`Failed to parse JSON chunk: ${line}`);
    return {done: false, responses: []};
  }
  return {done: false, responses: [...handler.processChunk(chunk)]};
}

/**
 * Accumulates responses from the Chat Completions endpoint. Serves both
 * streaming and non-streaming modes, holding mutable accumulation state (text,
 * tool-call parts, role, usage, and custom metadata).
 */
class ChatCompletionsResponseHandler {
  private contentText = '';
  private readonly toolCallParts = new Map<number, Part>();
  private role = '';
  private model = '';
  private readonly usage: Record<string, unknown> = {};
  private readonly customMetadata: Record<string, unknown> = {};
  private refusalStarted = false;

  /** Processes a complete non-streaming response into a single `LlmResponse`. */
  processResponse(response: Record<string, unknown>): LlmResponse {
    const choices = response['choices'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (!choices || choices.length === 0) {
      throw new Error('No choices found in response.');
    }
    const choice = choices[0];
    const message = (choice['message'] ?? {}) as Record<string, unknown>;
    this.addChatCompletionMessage(message);

    return {
      content: {role: this.role, parts: this.getContentParts()},
      usageMetadata: buildUsageMetadata(
        (response['usage'] ?? {}) as Record<string, unknown>,
      ),
      finishReason: mapFinishReason(choice['finish_reason']),
      modelVersion: response['model'] as string | undefined,
      customMetadata: pickCustomMetadata(response),
    };
  }

  /** Processes one streaming chunk, yielding partial and final responses. */
  *processChunk(chunk: Record<string, unknown>): Generator<LlmResponse> {
    if (chunk['model'] !== undefined) {
      this.model = chunk['model'] as string;
    }
    if (chunk['usage']) {
      Object.assign(this.usage, chunk['usage']);
    }
    Object.assign(this.customMetadata, pickCustomMetadata(chunk));

    const usageMetadata = Object.keys(this.usage).length
      ? buildUsageMetadata(this.usage)
      : undefined;

    const choices = chunk['choices'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (!choices || choices.length === 0) {
      if (usageMetadata || Object.keys(this.customMetadata).length) {
        yield {
          partial: true,
          modelVersion: this.model,
          usageMetadata,
          customMetadata: this.customMetadata,
        };
      }
      return;
    }

    const choice = choices[0];
    const delta = (choice['delta'] ?? {}) as Record<string, unknown>;
    const parts = this.addChatCompletionChunkDelta(delta);

    yield {
      partial: true,
      content: {role: this.role, parts},
      modelVersion: this.model,
      usageMetadata,
      customMetadata: this.customMetadata,
    };

    if (choice['finish_reason']) {
      yield {
        content: {role: this.role, parts: this.getContentParts()},
        finishReason: mapFinishReason(choice['finish_reason']),
        modelVersion: this.model,
        usageMetadata,
        customMetadata: this.customMetadata,
      };
    }
  }

  private addChatCompletionMessage(message: Record<string, unknown>): void {
    const toolCalls = (message['tool_calls'] ?? []) as Array<
      Record<string, unknown>
    >;
    for (const toolCall of toolCalls) {
      this.upsertToolCall(toolCall);
    }
    const functionCall = message['function_call'];
    if (functionCall) {
      this.upsertToolCall({type: 'function', function: functionCall});
    }
    this.accumulateContent(message);
    this.setRoleOnce((message['role'] as string) ?? 'model');
  }

  private addChatCompletionChunkDelta(delta: Record<string, unknown>): Part[] {
    const parts: Part[] = [];
    const toolCalls = (delta['tool_calls'] ?? []) as Array<
      Record<string, unknown>
    >;
    for (const toolCall of toolCalls) {
      parts.push(this.upsertToolCall(toolCall));
    }
    const text = this.accumulateContent(delta);
    if (text) {
      parts.push(createPartFromText(text));
    }
    this.setRoleOnce((delta['role'] as string) ?? 'model');
    return parts;
  }

  /**
   * Appends text content and refusal text. On the first refusal, the refusal
   * prefix (preceded by a newline if content already exists) is inserted.
   * Returns the text produced for this chunk.
   */
  private accumulateContent(source: Record<string, unknown>): string {
    let content = (source['content'] as string | null | undefined) ?? '';
    const refusal = (source['refusal'] as string | null | undefined) ?? '';

    if (content && this.refusalStarted) {
      logger.warn(
        'Received content after refusal has started. Dropping content.',
      );
      content = '';
    }

    let chunkText = '';
    if (content) {
      chunkText += content;
    }
    if (refusal && !this.refusalStarted) {
      this.refusalStarted = true;
      if (this.contentText || chunkText) {
        chunkText += '\n';
      }
      chunkText += REFUSAL_PREFIX;
    }
    if (refusal) {
      chunkText += refusal;
    }
    if (chunkText) {
      this.contentText += chunkText;
    }
    return chunkText;
  }

  /** Returns the fully accumulated parts (text first, then tool calls). */
  private getContentParts(): Part[] {
    const parts: Part[] = [];
    if (this.contentText) {
      parts.push(createPartFromText(this.contentText));
    }
    const indices = [...this.toolCallParts.keys()].sort((a, b) => a - b);
    for (const index of indices) {
      parts.push(this.toolCallParts.get(index)!);
    }
    return parts;
  }

  /**
   * Upserts a tool call into the accumulator, merging `arguments` deltas into
   * the accumulated part. Returns the delta `Part` for this chunk.
   */
  private upsertToolCall(toolCall: Record<string, unknown>): Part {
    let index = toolCall['index'] as number | undefined;
    if (index === undefined || index === null) {
      index = this.toolCallParts.size;
    }
    if (!this.toolCallParts.has(index)) {
      this.toolCallParts.set(index, {functionCall: {}});
    }
    const part = this.toolCallParts.get(index)!;
    const deltaPart: Part = {functionCall: {}};

    const callType = toolCall['type'];
    if (
      callType !== undefined &&
      callType !== null &&
      callType !== 'function'
    ) {
      throw new Error(
        `Unsupported tool_call type: ${callType} in call ` +
          `${JSON.stringify(toolCall)}`,
      );
    }

    const func = (toolCall['function'] ?? {}) as Record<string, unknown>;
    const argsDelta = func['arguments'] as string | undefined;
    if (argsDelta) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(argsDelta) as Record<string, unknown>;
      } catch {
        throw new Error(`Failed to parse arguments: ${argsDelta}`);
      }
      deltaPart.functionCall!.args = args;
      part.functionCall!.args = {...(part.functionCall!.args ?? {}), ...args};
    }

    const name = func['name'] as string | undefined;
    if (name) {
      part.functionCall!.name = name;
      deltaPart.functionCall!.name = name;
    }
    const id = toolCall['id'] as string | undefined;
    if (id) {
      part.functionCall!.id = id;
      deltaPart.functionCall!.id = id;
    }

    const thoughtSignature = (
      (toolCall['extra_content'] as Record<string, unknown> | undefined)?.[
        'google'
      ] as Record<string, unknown> | undefined
    )?.['thought_signature'] as string | undefined;
    if (thoughtSignature) {
      part.thoughtSignature = thoughtSignature;
      deltaPart.thoughtSignature = thoughtSignature;
    }
    return deltaPart;
  }

  /** Sets the response role on the first message/delta seen; later calls are ignored. */
  private setRoleOnce(role: string): void {
    if (!this.role) {
      this.role = role === 'assistant' ? 'model' : role;
    }
  }
}

/**
 * Copies the present {@link CUSTOM_METADATA_FIELDS} from a response object.
 */
function pickCustomMetadata(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const customMetadata: Record<string, unknown> = {};
  for (const key of CUSTOM_METADATA_FIELDS) {
    const value = response[key];
    if (value !== undefined && value !== null) {
      customMetadata[key] = value;
    }
  }
  return customMetadata;
}
