/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FunctionDeclaration,
  FunctionResponse,
  GenerateContentConfig,
  Part,
} from '@google/genai';
import type * as ociCommon from 'oci-common';
import type {models, requests, responses} from 'oci-generativeaiinference';

import {genaiSchemaToJsonSchema} from '../utils/genai_schema_to_json.js';
import {logger} from '../utils/logger.js';
import {loadOptionalPeer} from '../utils/optional_peer.js';
import {toJsonSchema} from '../utils/schema.js';
import {isZodSchema} from '../utils/simple_zod_to_json.js';
import {readSseData} from '../utils/sse_utils.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

const DEFAULT_MODEL = 'google.gemini-2.5-flash';
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_AUTH_PROFILE = 'DEFAULT';
const DEFAULT_AUTH_FILE_LOCATION = '~/.oci/config';
const DEFAULT_SERVICE_ENDPOINT =
  'https://inference.generativeai.us-chicago-1.oci.oraclecloud.com';
const DEFAULT_MEDIA_MIME_TYPE = 'application/octet-stream';

const COMPARTMENT_ID_ENV_VAR = 'OCI_COMPARTMENT_ID';
const SERVICE_ENDPOINT_ENV_VAR = 'OCI_SERVICE_ENDPOINT';
const ENDPOINT_ID_ENV_VAR = 'OCI_ENDPOINT_ID';

/** `apiFormat` of the GenericChat API this provider speaks. */
const GENERIC_API_FORMAT = 'GENERIC';
/** `type` discriminator of an OCI function tool and of a function tool call. */
const FUNCTION_TYPE = 'FUNCTION';
/** `type` discriminator of an OCI text content block. */
const TEXT_CONTENT_TYPE = 'TEXT';
/** Final frame of an OCI chat stream. It carries no chunk. */
const DONE_SENTINEL = '[DONE]';

/** The npm packages that back this provider, loaded on first call. */
const INFERENCE_PACKAGE = 'oci-generativeaiinference';
const COMMON_PACKAGE = 'oci-common';
const FEATURE = 'OCIGenAILlm';

/**
 * The slice of the OCI inference client this provider calls.
 *
 * `GenerativeAiInferenceClient` satisfies it structurally, so a real client is
 * accepted as-is. Depending on the one method that is used keeps the seam
 * small enough for a caller — or a test — to supply its own.
 */
export interface OciChatClient {
  chat(
    chatRequest: requests.ChatRequest,
  ): Promise<responses.ChatResponse | ReadableStream<Uint8Array> | null>;
}

/** The `role` discriminator of each OCI GenericChat message type. */
export enum OciRole {
  System = 'SYSTEM',
  User = 'USER',
  Assistant = 'ASSISTANT',
  Tool = 'TOOL',
}

/** How the provider authenticates against OCI. */
export type OCIAuthType =
  | 'API_KEY'
  | 'INSTANCE_PRINCIPAL'
  | 'RESOURCE_PRINCIPAL';

/** Constructor options for {@link OCIGenAILlm}. */
export interface OCIGenAILlmParams {
  /**
   * OCI model id, e.g. `google.gemini-2.0-flash-001`. Used as the model id for
   * on-demand serving. For dedicated serving set `endpointId` instead, and
   * `model` becomes informational only.
   */
  model?: string;
  /**
   * Dedicated endpoint OCID. When it resolves, requests use dedicated serving
   * mode; otherwise on-demand serving mode is used. Falls back to the
   * `OCI_ENDPOINT_ID` environment variable.
   */
  endpointId?: string;
  /**
   * OCI compartment OCID. Falls back to the `OCI_COMPARTMENT_ID` environment
   * variable. One of the two must be set before a call is made.
   */
  compartmentId?: string;
  /**
   * Generative AI inference endpoint URL. Falls back to the
   * `OCI_SERVICE_ENDPOINT` environment variable, then to the us-chicago-1
   * endpoint.
   */
  serviceEndpoint?: string;
  /** Authentication type. Defaults to `API_KEY`. */
  authType?: OCIAuthType;
  /** Config profile used for `API_KEY` authentication. Defaults to `DEFAULT`. */
  authProfile?: string;
  /** OCI config file used for `API_KEY` authentication. Defaults to `~/.oci/config`. */
  authFileLocation?: string;
  /** Maximum number of tokens to generate. Defaults to 2048. */
  maxTokens?: number;
  /**
   * Reasoning-token budget for reasoning-capable models. Left unset, OCI
   * chooses. Non-reasoning models ignore it.
   */
  reasoningEffort?: models.GenericChatRequest.ReasoningEffort;
  /**
   * A pre-built inference client, for callers that need their own retry or
   * circuit-breaker configuration. When set, none of the auth or service
   * endpoint options are read.
   */
  client?: OciChatClient;
}

/**
 * A tool-call delta as OCI streams it.
 *
 * The SDK types the non-streaming `ToolCall`, which requires `id` and carries
 * no `index`. A streamed delta has neither property reliably, so the wire
 * shape is declared here rather than borrowed from a type it does not match.
 */
interface OciToolCallDelta {
  index?: number;
  id?: string;
  name?: string;
  arguments?: string;
}

/**
 * One chunk of an OCI GenericChat stream, in the camelCase spelling the
 * `/20231130/` schema uses on the wire. The SDK has no type for it: its
 * `Message` requires a role, and a chunk carries only the fields that changed.
 */
interface OciStreamChunk {
  /**
   * Present only when the frame carried a message object. Its two lists are
   * always arrays, because `parseStreamChunk` builds them.
   */
  message?: {
    content: Array<{type?: string; text?: string}>;
    toolCalls: OciToolCallDelta[];
  };
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    completionTokensDetails?: {reasoningTokens?: number};
  };
}

/** A tool call assembled from one or more streamed deltas. */
interface AccumulatedToolCall {
  id: string;
  name: string;
  args: string;
}

/** The message pieces one `Content` contributes, in the order they appear. */
interface ContentPieces {
  textParts: string[];
  mediaBlocks: OciMediaContent[];
  toolCalls: models.FunctionCall[];
  toolResults: models.ToolMessage[];
}

/**
 * The OCI content blocks that carry media.
 *
 * `models.ChatContent` is the base of these four and declares only `type`, so
 * a block has to be built as its concrete subtype for its URL field to be
 * checked at all.
 */
export type OciMediaContent =
  | models.ImageContent
  | models.AudioContent
  | models.VideoContent
  | models.DocumentContent;

/**
 * Narrows an unknown value to a plain object.
 *
 * An array is an object to `typeof`, so it is excluded explicitly: every
 * caller here wants a keyed record, and a JSON array reaching one of them as
 * a tool-argument set or a schema would be silently wrong.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a string field of a wire object, or undefined when it is absent. */
function stringField(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/** Reads a numeric field of a wire object, or undefined when it is absent. */
function numberField(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === 'number' ? value : undefined;
}

/** Narrows a value to a web stream, without depending on its constructor. */
function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    isJsonObject(value) &&
    'getReader' in value &&
    typeof value.getReader === 'function'
  );
}

/** The OCI text block that every message type carries its prose in. */
function textContent(text: string): models.TextContent {
  return {type: TEXT_CONTENT_TYPE, text};
}

/** Maps an ADK content role onto the OCI role that carries it. */
export function toOciRole(role?: string): OciRole.Assistant | OciRole.User {
  return role === 'model' || role === 'assistant'
    ? OciRole.Assistant
    : OciRole.User;
}

/**
 * Maps a multimodal part onto OCI content blocks, keyed on the primary type of
 * its mime type. Inline bytes become a data URL and file data passes its URI
 * through. Anything that is not image, audio or video — a PDF, plain text, an
 * unknown mime type — is sent as a document.
 *
 * @param part The part to convert.
 * @return One content block, or none when the part carries no media.
 */
export function mediaBlocksForPart(part: Part): OciMediaContent[] {
  let url: string;
  let mimeType: string;
  if (part.inlineData?.data !== undefined) {
    mimeType = part.inlineData.mimeType || DEFAULT_MEDIA_MIME_TYPE;
    url = `data:${mimeType};base64,${part.inlineData.data}`;
  } else if (part.fileData?.fileUri) {
    url = part.fileData.fileUri;
    mimeType = part.fileData.mimeType ?? '';
  } else {
    return [];
  }
  switch (mimeType.split('/')[0].toLowerCase()) {
    case 'image':
      return [{type: 'IMAGE', imageUrl: {url}}];
    case 'audio':
      return [{type: 'AUDIO', audioUrl: {url}}];
    case 'video':
      return [{type: 'VIDEO', videoUrl: {url}}];
    default:
      return [{type: 'DOCUMENT', documentUrl: {url}}];
  }
}

/**
 * Maps the media a tool attached to its response onto OCI content blocks.
 *
 * @param functionResponse The tool result to read the media from.
 * @return One content block per attached blob, in order.
 */
export function functionResponseMediaBlocks(
  functionResponse: FunctionResponse,
): OciMediaContent[] {
  const blocks: OciMediaContent[] = [];
  for (const part of functionResponse.parts ?? []) {
    const data = part.inlineData?.data;
    const mimeType = part.inlineData?.mimeType;
    if (data === undefined || !mimeType) {
      continue;
    }
    blocks.push(...mediaBlocksForPart({inlineData: {data, mimeType}}));
  }
  return blocks;
}

/** Sorts the parts of one `Content` into the pieces an OCI message is built from. */
function collectContentPieces(content: Content): ContentPieces {
  const pieces: ContentPieces = {
    textParts: [],
    mediaBlocks: [],
    toolCalls: [],
    toolResults: [],
  };
  for (const part of content.parts ?? []) {
    if (part.text) {
      pieces.textParts.push(part.text);
    } else if (part.functionCall) {
      pieces.toolCalls.push({
        id: part.functionCall.id ?? '',
        type: FUNCTION_TYPE,
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    } else if (part.functionResponse) {
      pieces.toolResults.push({
        role: OciRole.Tool,
        toolCallId: part.functionResponse.id ?? '',
        content: [
          textContent(JSON.stringify(part.functionResponse.response ?? {})),
        ],
      });
      // A tool message carries text only, so media the tool attached to its
      // result has to follow the tool results as its own message.
      pieces.mediaBlocks.push(
        ...functionResponseMediaBlocks(part.functionResponse),
      );
    } else if (part.inlineData || part.fileData) {
      pieces.mediaBlocks.push(...mediaBlocksForPart(part));
    }
  }
  return pieces;
}

/**
 * Converts one ADK `Content` into the OCI messages that carry it.
 *
 * Tool results become one `ToolMessage` each and always come first, so a
 * conversation keeps the order the model produced. The remaining parts become
 * a single assistant or user message.
 *
 * @param content The content to convert.
 * @return The messages to append to the request, in order.
 */
export function contentToOciMessages(content: Content): models.Message[] {
  const {textParts, mediaBlocks, toolCalls, toolResults} =
    collectContentPieces(content);
  const messages: models.Message[] = [...toolResults];
  const hasOtherParts =
    textParts.length > 0 || mediaBlocks.length > 0 || toolCalls.length > 0;
  if (toolResults.length > 0 && !hasOtherParts) {
    return messages;
  }

  const prose = textParts.length > 0 ? [textContent(textParts.join('\n'))] : [];
  if (toOciRole(content.role) === OciRole.Assistant) {
    const assistant: models.AssistantMessage = {
      role: OciRole.Assistant,
      content: prose,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    messages.push(assistant);
    return messages;
  }

  const userContent: models.ChatContent[] = [...prose, ...mediaBlocks];
  if (messages.length === 0 || userContent.length > 0) {
    const user: models.UserMessage = {
      role: OciRole.User,
      content: userContent,
    };
    messages.push(user);
  }
  return messages;
}

/**
 * True when `schema` is written in the genai/OpenAPI dialect rather than plain
 * JSON Schema. The two are the same shape; genai spells its type names in
 * upper case (`OBJECT`) where JSON Schema spells them in lower case.
 */
function isGenaiDialect(schema: Record<string, unknown>): boolean {
  const type = schema['type'];
  return typeof type === 'string' && type === type.toUpperCase();
}

/**
 * Renders a `responseSchema` as JSON Schema.
 *
 * `GenerateContentConfig.responseSchema` is typed `unknown` and ADK accepts
 * three forms there: a Zod type, a genai `Schema`, and a schema that is
 * already plain JSON Schema. Only the first two need converting; the third
 * reaches OCI unchanged. Anything else has no schema to send.
 */
function responseJsonSchema(
  schema: unknown,
): Record<string, unknown> | undefined {
  if (isZodSchema(schema)) {
    return toJsonSchema(schema);
  }
  if (!isJsonObject(schema)) {
    return undefined;
  }
  return isGenaiDialect(schema) ? genaiSchemaToJsonSchema(schema) : schema;
}

/**
 * Maps the response settings of a request onto an OCI response format.
 *
 * A `responseSchema` asks for strict structured output. A
 * `responseMimeType` on its own asks for free-form JSON or for plain text.
 *
 * @param config The generation config of the request.
 * @return The response format to send, or undefined to let OCI decide.
 */
export function buildResponseFormat(
  config: GenerateContentConfig,
): models.GenericChatRequest['responseFormat'] {
  if (config.responseSchema !== undefined && config.responseSchema !== null) {
    const schema = responseJsonSchema(config.responseSchema);
    if (!schema) {
      return undefined;
    }
    return {
      type: 'JSON_SCHEMA',
      jsonSchema: {
        name: stringField(schema, 'title') ?? 'response',
        description: stringField(schema, 'description'),
        schema,
        isStrict: true,
      },
    };
  }
  switch (config.responseMimeType) {
    case 'application/json':
      return {type: 'JSON_OBJECT'};
    case 'text/plain':
      return {type: 'TEXT'};
    default:
      return undefined;
  }
}

/** The JSON Schema an OCI tool advertises for its arguments. */
function toolParameters(fn: FunctionDeclaration): Record<string, unknown> {
  if (isJsonObject(fn.parametersJsonSchema)) {
    return fn.parametersJsonSchema;
  }
  if (fn.parameters?.properties) {
    return genaiSchemaToJsonSchema(fn.parameters);
  }
  return {type: 'object', properties: {}};
}

/**
 * Converts an ADK function declaration into an OCI tool definition.
 *
 * @param fn The declaration to convert.
 * @return The tool definition to advertise to the model.
 */
export function functionDeclarationToOciTool(
  fn: FunctionDeclaration,
): models.FunctionDefinition {
  return {
    type: FUNCTION_TYPE,
    name: fn.name,
    description: fn.description ?? '',
    parameters: toolParameters(fn),
  };
}

/**
 * The function declarations of a request's first tool entry.
 *
 * adk-python reads only the first entry, and only when it is a plain `Tool`
 * rather than a callable one, so the port does the same.
 */
function firstToolDeclarations(
  config?: GenerateContentConfig,
): FunctionDeclaration[] {
  const tool = config?.tools?.[0];
  if (!tool || !('functionDeclarations' in tool)) {
    return [];
  }
  return tool.functionDeclarations ?? [];
}

/**
 * Parses the JSON `arguments` of a tool call.
 *
 * A model can emit arguments that are not valid JSON, or that are valid JSON
 * but not an object. Neither is worth failing the whole turn over, so both
 * produce an empty argument set.
 */
function parseToolArguments(args?: string): Record<string, unknown> {
  if (!args) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(args);
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Builds the ADK part that carries one tool call. */
function functionCallPart(
  id: string,
  name: string | undefined,
  args: string | undefined,
): Part {
  return {functionCall: {id, name, args: parseToolArguments(args)}};
}

/**
 * The prose a content block carries, or undefined when it carries none.
 *
 * `models.ChatContent` declares only `type`, so the text of a block has to be
 * read defensively rather than through the declared type.
 */
function blockText(block: models.ChatContent): string | undefined {
  const text = 'text' in block ? block.text : undefined;
  return typeof text === 'string' ? text : undefined;
}

/** Narrows a chat body to the non-streaming response the SDK may return. */
function isChatResponse(body: unknown): body is responses.ChatResponse {
  return isJsonObject(body) && 'chatResult' in body;
}

/** Narrows an OCI chat response to the GenericChat shape this provider asks for. */
function isGenericChatResponse(
  response: models.ChatResult['chatResponse'],
): response is models.GenericChatResponse {
  return response.apiFormat === GENERIC_API_FORMAT;
}

/** Narrows an OCI tool call to the function-call shape that carries a name. */
function isFunctionCall(call: models.ToolCall): call is models.FunctionCall {
  return call.type === FUNCTION_TYPE;
}

/** The tool calls of a chat choice's message, which only an assistant carries. */
function messageToolCalls(
  message?: models.ChatChoice['message'],
): models.ToolCall[] {
  return message && 'toolCalls' in message ? (message.toolCalls ?? []) : [];
}

/** Assembles the usage metadata of a response from OCI's token counts. */
function usageMetadata(
  promptTokenCount: number,
  candidatesTokenCount: number,
  reasoningTokens: number,
): LlmResponse['usageMetadata'] {
  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount: promptTokenCount + candidatesTokenCount,
    thoughtsTokenCount: reasoningTokens || undefined,
  };
}

/**
 * Converts a non-streaming OCI chat response into an ADK response.
 *
 * @param response The response the inference client returned.
 * @return The text and tool calls of the first choice, with token usage.
 */
export function ociResponseToLlmResponse(
  response: responses.ChatResponse,
): LlmResponse {
  const chatResponse = response.chatResult.chatResponse;
  const generic = isGenericChatResponse(chatResponse)
    ? chatResponse
    : undefined;
  const usage = generic?.usage;
  const message = generic?.choices?.[0]?.message;

  const parts: Part[] = [];
  for (const block of message?.content ?? []) {
    const text = blockText(block);
    if (text) {
      parts.push({text});
    }
  }
  for (const call of messageToolCalls(message)) {
    const fn = isFunctionCall(call) ? call : undefined;
    parts.push(functionCallPart(call.id ?? '', fn?.name, fn?.arguments));
  }

  return {
    content: {role: 'model', parts},
    usageMetadata: usageMetadata(
      usage?.promptTokens ?? 0,
      usage?.completionTokens ?? 0,
      usage?.completionTokensDetails?.reasoningTokens ?? 0,
    ),
  };
}

/** Reads the text blocks of a streamed message, dropping anything malformed. */
function streamTextBlocks(
  value: unknown,
): Array<{type?: string; text?: string}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isJsonObject).map((block) => ({
    type: stringField(block, 'type'),
    text: stringField(block, 'text'),
  }));
}

/** Reads the tool-call deltas of a streamed message. */
function streamToolCalls(value: unknown): OciToolCallDelta[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isJsonObject).map((delta) => ({
    index: numberField(delta, 'index'),
    id: stringField(delta, 'id'),
    name: stringField(delta, 'name'),
    arguments: stringField(delta, 'arguments'),
  }));
}

/** Reads the usage counts of a stream chunk. */
function streamUsage(value: unknown): OciStreamChunk['usage'] {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const details = value['completionTokensDetails'];
  return {
    promptTokens: numberField(value, 'promptTokens'),
    completionTokens: numberField(value, 'completionTokens'),
    completionTokensDetails: isJsonObject(details)
      ? {reasoningTokens: numberField(details, 'reasoningTokens')}
      : undefined,
  };
}

/**
 * Reads one SSE frame of a chat stream, skipping a frame that is not a JSON
 * object.
 *
 * The frame is parsed field by field rather than cast, because it arrives as
 * untyped text: a chunk whose `text` is a number, or whose `toolCalls` is not
 * an array, must not reach the accumulators as if it had the declared shape.
 */
function parseStreamChunk(data: string): OciStreamChunk | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    logger.debug(`Could not parse an OCI SSE frame: ${data}`);
    return undefined;
  }
  if (!isJsonObject(parsed)) {
    return undefined;
  }
  const message = parsed['message'];
  return {
    message: isJsonObject(message)
      ? {
          content: streamTextBlocks(message['content']),
          toolCalls: streamToolCalls(message['toolCalls']),
        }
      : undefined,
    usage: streamUsage(parsed['usage']),
  };
}

/**
 * Folds streamed tool-call deltas into `accumulated`, keyed by the index OCI
 * assigns them.
 *
 * OCI sends a whole call in one delta for some models and splits the arguments
 * across deltas for others, so `id` and `name` overwrite while `arguments`
 * concatenate.
 */
function accumulateToolCalls(
  accumulated: Map<number, AccumulatedToolCall>,
  deltas: OciToolCallDelta[],
): void {
  deltas.forEach((delta, position) => {
    const index = delta.index ?? position;
    const call = accumulated.get(index) ?? {id: '', name: '', args: ''};
    accumulated.set(index, {
      id: delta.id || call.id,
      name: delta.name || call.name,
      args: call.args + (delta.arguments ?? ''),
    });
  });
}

/** Applies the sampling and decoding settings of a request to a chat request. */
function applyGenerationConfig(
  chatRequest: models.GenericChatRequest,
  config: GenerateContentConfig,
): void {
  if (config.maxOutputTokens !== undefined) {
    chatRequest.maxTokens = config.maxOutputTokens;
  }
  if (config.temperature !== undefined) {
    chatRequest.temperature = config.temperature;
  }
  if (config.topP !== undefined) {
    chatRequest.topP = config.topP;
  }
  if (config.topK !== undefined) {
    chatRequest.topK = Math.trunc(config.topK);
  }
  if (config.frequencyPenalty !== undefined) {
    chatRequest.frequencyPenalty = config.frequencyPenalty;
  }
  if (config.presencePenalty !== undefined) {
    chatRequest.presencePenalty = config.presencePenalty;
  }
  if (config.seed !== undefined) {
    chatRequest.seed = config.seed;
  }
  if (config.stopSequences?.length) {
    chatRequest.stop = [...config.stopSequences];
  }
  const responseFormat = buildResponseFormat(config);
  if (responseFormat) {
    chatRequest.responseFormat = responseFormat;
  }
}

/**
 * Builds the OCI authentication provider for an auth type.
 *
 * Instance and resource principals reach the instance metadata service and the
 * resource-principal environment respectively; `API_KEY` reads the config file
 * from disk.
 */
async function buildAuthProvider(
  common: typeof ociCommon,
  authType: OCIAuthType,
  authProfile: string,
  authFileLocation: string,
): Promise<ociCommon.AuthenticationDetailsProvider> {
  switch (authType) {
    case 'INSTANCE_PRINCIPAL':
      return new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
    case 'RESOURCE_PRINCIPAL':
      return common.ResourcePrincipalAuthenticationDetailsProvider.builder();
    default:
      return new common.ConfigFileAuthenticationDetailsProvider(
        authFileLocation,
        authProfile,
      );
  }
}

/**
 * Runs an agent against a model hosted on Oracle Cloud Infrastructure
 * Generative AI, over the `/20231130/` GenericChat API.
 *
 * The OCI SDK is an optional peer dependency, loaded when the first call is
 * made. Install `oci-common` and `oci-generativeaiinference` to use this
 * provider.
 *
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'weather',
 *   model: new OCIGenAILlm({
 *     model: 'google.gemini-2.0-flash-001',
 *     compartmentId: process.env['OCI_COMPARTMENT_ID'],
 *   }),
 * });
 * ```
 */
export class OCIGenAILlm extends BaseLlm {
  private readonly endpointId?: string;
  private readonly compartmentId?: string;
  private readonly serviceEndpoint?: string;
  private readonly authType: OCIAuthType;
  private readonly authProfile: string;
  private readonly authFileLocation: string;
  private readonly maxTokens: number;
  private readonly reasoningEffort?: models.GenericChatRequest.ReasoningEffort;
  private clientPromise?: Promise<OciChatClient>;

  /** Model id patterns OCI Generative AI serves. */
  static override readonly supportedModels: Array<string | RegExp> = [
    /meta\.llama-.*/,
    /google\.gemini-.*/,
    /google\.gemma-.*/,
    /xai\.grok-.*/,
    /mistralai\.mistral-.*/,
    /mistralai\.mixtral-.*/,
    /nvidia\..*/,
  ];

  constructor({
    model = DEFAULT_MODEL,
    endpointId,
    compartmentId,
    serviceEndpoint,
    authType = 'API_KEY',
    authProfile = DEFAULT_AUTH_PROFILE,
    authFileLocation = DEFAULT_AUTH_FILE_LOCATION,
    maxTokens = DEFAULT_MAX_TOKENS,
    reasoningEffort,
    client,
  }: OCIGenAILlmParams = {}) {
    super({model});
    this.endpointId = endpointId;
    this.compartmentId = compartmentId;
    this.serviceEndpoint = serviceEndpoint;
    this.authType = authType;
    this.authProfile = authProfile;
    this.authFileLocation = authFileLocation;
    this.maxTokens = maxTokens;
    this.reasoningEffort = reasoningEffort;
    this.clientPromise = client ? Promise.resolve(client) : undefined;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    if (stream) {
      yield* this.generateContentStreaming(llmRequest, abortSignal);
      return;
    }
    const client = await this.getClient();
    const chatDetails = this.buildChatDetails(llmRequest, false);
    logger.debug(`Sending a request to OCI Generative AI: ${this.model}`);
    const body = await client.chat({chatDetails});
    if (!isChatResponse(body)) {
      throw new Error(
        'OCI Generative AI answered a chat request without a chat result.',
      );
    }
    yield ociResponseToLlmResponse(body);
  }

  /**
   * Always throws. OCI Generative AI serves the request/response chat API
   * only, so there is no live connection to open.
   */
  override connect(): Promise<BaseLlmConnection> {
    throw new Error(
      'OCI Generative AI has no bidirectional live API, so OCIGenAILlm ' +
        'cannot open a live connection. Use generateContentAsync instead.',
    );
  }

  /**
   * Yields one partial response per streamed text delta, then a final response
   * carrying the whole text, the accumulated tool calls and the token usage.
   */
  private async *generateContentStreaming(
    llmRequest: LlmRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const client = await this.getClient();
    const chatDetails = this.buildChatDetails(llmRequest, true);
    logger.debug(
      `Sending a stream request to OCI Generative AI: ${this.model}`,
    );
    const body = await client.chat({chatDetails});
    if (!isReadableStream(body)) {
      throw new Error(
        'OCI Generative AI answered a streaming request without a stream.',
      );
    }

    const toolCalls = new Map<number, AccumulatedToolCall>();
    let text = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let reasoningTokens = 0;

    for await (const data of readSseData(body)) {
      if (data === DONE_SENTINEL || abortSignal?.aborted) {
        break;
      }
      const chunk = parseStreamChunk(data);
      if (chunk?.usage) {
        promptTokens = chunk.usage.promptTokens ?? 0;
        completionTokens = chunk.usage.completionTokens ?? 0;
        reasoningTokens =
          chunk.usage.completionTokensDetails?.reasoningTokens ?? 0;
        continue;
      }
      if (!chunk?.message) {
        continue;
      }
      for (const block of chunk.message.content) {
        if (block.type === TEXT_CONTENT_TYPE && block.text) {
          text += block.text;
          yield {
            content: {role: 'model', parts: [{text: block.text}]},
            partial: true,
          };
        }
      }
      accumulateToolCalls(toolCalls, chunk.message.toolCalls);
    }

    const parts: Part[] = text ? [{text}] : [];
    // adk-python emits the accumulated calls sorted by name, and the order of
    // the parts decides the order the caller runs the tools in, so it is
    // observable behaviour that has to match. The non-streaming path emits in
    // wire order instead; that difference is inherited from the reference
    // implementation, not introduced here.
    const ordered = [...toolCalls.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const call of ordered) {
      parts.push(functionCallPart(call.id, call.name, call.args));
    }
    yield {
      content: {role: 'model', parts},
      usageMetadata: usageMetadata(
        promptTokens,
        completionTokens,
        reasoningTokens,
      ),
      partial: false,
    };
  }

  /**
   * The inference client, built on first use and shared afterwards. The
   * promise itself is memoised so that concurrent first calls share one
   * client rather than racing to build two.
   */
  private getClient(): Promise<OciChatClient> {
    this.clientPromise ??= this.buildClient();
    return this.clientPromise;
  }

  private async buildClient(): Promise<OciChatClient> {
    const [inference, common] = await Promise.all([
      loadOptionalPeer(
        {packageName: INFERENCE_PACKAGE, feature: FEATURE},
        () => import('oci-generativeaiinference'),
      ),
      loadOptionalPeer(
        {packageName: COMMON_PACKAGE, feature: FEATURE},
        () => import('oci-common'),
      ),
    ]);
    const client = new inference.GenerativeAiInferenceClient({
      authenticationDetailsProvider: await buildAuthProvider(
        common,
        this.authType,
        this.authProfile,
        this.authFileLocation,
      ),
    });
    client.endpoint = this.resolveServiceEndpoint();
    return client;
  }

  /** Builds the OCI chat request that carries an ADK request. */
  private buildChatDetails(
    llmRequest: LlmRequest,
    isStream: boolean,
  ): models.ChatDetails {
    const messages: models.Message[] = [];
    for (const content of llmRequest.contents) {
      messages.push(...contentToOciMessages(content));
    }
    const config = llmRequest.config;
    const systemInstruction = config?.systemInstruction;
    if (typeof systemInstruction === 'string' && systemInstruction) {
      const system: models.SystemMessage = {
        role: OciRole.System,
        content: [textContent(systemInstruction)],
      };
      messages.unshift(system);
    }

    const chatRequest: models.GenericChatRequest = {
      apiFormat: GENERIC_API_FORMAT,
      messages,
      maxTokens: this.maxTokens,
    };
    if (config) {
      applyGenerationConfig(chatRequest, config);
    }
    // The constructor setting applies whatever the per-request config says.
    if (this.reasoningEffort !== undefined) {
      chatRequest.reasoningEffort = this.reasoningEffort;
    }
    const declarations = firstToolDeclarations(config);
    if (declarations.length > 0) {
      chatRequest.tools = declarations.map(functionDeclarationToOciTool);
    }
    if (isStream) {
      chatRequest.isStream = true;
      chatRequest.streamOptions = {isIncludeUsage: true};
    }

    return {
      compartmentId: this.resolveCompartmentId(),
      servingMode: this.buildServingMode(),
      chatRequest,
    };
  }

  /** Dedicated serving when an endpoint id resolves, on-demand otherwise. */
  private buildServingMode(): models.ChatDetails['servingMode'] {
    const endpointId =
      this.endpointId || process.env[ENDPOINT_ID_ENV_VAR] || '';
    if (endpointId) {
      const dedicated: models.DedicatedServingMode = {
        servingType: 'DEDICATED',
        endpointId,
      };
      return dedicated;
    }
    const onDemand: models.OnDemandServingMode = {
      servingType: 'ON_DEMAND',
      modelId: this.model,
    };
    return onDemand;
  }

  private resolveCompartmentId(): string {
    const compartmentId =
      this.compartmentId || process.env[COMPARTMENT_ID_ENV_VAR];
    if (!compartmentId) {
      throw new Error(
        'compartmentId must be set on OCIGenAILlm or via the ' +
          `${COMPARTMENT_ID_ENV_VAR} environment variable.`,
      );
    }
    return compartmentId;
  }

  private resolveServiceEndpoint(): string {
    return (
      this.serviceEndpoint ||
      process.env[SERVICE_ENDPOINT_ENV_VAR] ||
      DEFAULT_SERVICE_ENDPOINT
    );
  }
}
