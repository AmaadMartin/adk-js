/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
  Part,
  Schema,
  Type,
} from '@google/genai';
import type {AuthenticationDetailsProvider} from 'oci-common';
import type {
  GenerativeAiInferenceClient,
  models,
  responses,
} from 'oci-generativeaiinference';

import {logger} from '../utils/logger.js';
import {toJsonSchema} from '../utils/schema.js';
import {isZodSchema} from '../utils/simple_zod_to_json.js';
import {readSseData} from '../utils/sse_utils.js';

import {BaseLlm} from './base_llm.js';
import {BaseLlmConnection} from './base_llm_connection.js';
import {extractSystemInstruction} from './interactions_utils.js';
import {LlmRequest} from './llm_request.js';
import {LlmResponse} from './llm_response.js';

const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_AUTH_TYPE: OciAuthType = 'API_KEY';
const DEFAULT_AUTH_PROFILE = 'DEFAULT';
const DEFAULT_AUTH_FILE_LOCATION = '~/.oci/config';
const DEFAULT_SERVICE_ENDPOINT =
  'https://inference.generativeai.us-chicago-1.oci.oraclecloud.com';
const DEFAULT_MEDIA_MIME_TYPE = 'application/octet-stream';
const DEFAULT_RESPONSE_SCHEMA_NAME = 'response';

/** The type names of the genai schema dialect, which JSON Schema lower-cases. */
const GENAI_SCHEMA_TYPES: ReadonlySet<string> = new Set(Object.values(Type));

const COMPARTMENT_ID_ENV_VAR = 'OCI_COMPARTMENT_ID';
const SERVICE_ENDPOINT_ENV_VAR = 'OCI_SERVICE_ENDPOINT';
const ENDPOINT_ID_ENV_VAR = 'OCI_ENDPOINT_ID';

/** Ends an OCI Generative AI event stream. */
const STREAM_DONE_SENTINEL = '[DONE]';

/** `apiFormat` of the chat request this provider emits. */
const GENERIC_API_FORMAT = 'GENERIC';

/** `type` of an OCI `FunctionCall` and of an OCI `FunctionDefinition`. */
const FUNCTION_TYPE = 'FUNCTION';

/** OCI `Message.role` discriminators. */
export enum OciRole {
  System = 'SYSTEM',
  User = 'USER',
  Assistant = 'ASSISTANT',
  Tool = 'TOOL',
}

/** OCI `ChatContent.type` discriminators. */
enum OciContentType {
  Text = 'TEXT',
  Image = 'IMAGE',
  Audio = 'AUDIO',
  Video = 'VIDEO',
  Document = 'DOCUMENT',
}

/** OCI `ResponseFormat.type` discriminators. */
enum OciResponseFormatType {
  Text = 'TEXT',
  JsonObject = 'JSON_OBJECT',
  JsonSchema = 'JSON_SCHEMA',
}

/** OCI `ServingMode.servingType` discriminators. */
enum OciServingType {
  OnDemand = 'ON_DEMAND',
  Dedicated = 'DEDICATED',
}

/** OCI authentication method. */
export type OciAuthType =
  | 'API_KEY'
  | 'INSTANCE_PRINCIPAL'
  | 'RESOURCE_PRINCIPAL';

/**
 * Reasoning-token budget for reasoning-capable models. The members mirror
 * `GenericChatRequest.ReasoningEffort` in `oci-generativeaiinference`.
 */
export type OciReasoningEffort = 'NONE' | 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';

/** Constructor options for {@link OciGenAiLlm}. */
export interface OciGenAiLlmParams {
  /**
   * OCI model ID, for example `google.gemini-2.5-flash`. Used as the `modelId`
   * of on-demand serving; informational only for dedicated serving.
   */
  model: string;
  /**
   * Dedicated endpoint OCID. When set, requests use dedicated serving instead
   * of on-demand. Falls back to the `OCI_ENDPOINT_ID` environment variable.
   */
  endpointId?: string;
  /**
   * Compartment OCID. Falls back to the `OCI_COMPARTMENT_ID` environment
   * variable, and is required by the time a request is made.
   */
  compartmentId?: string;
  /**
   * Service endpoint URL. Falls back to the `OCI_SERVICE_ENDPOINT` environment
   * variable, then to the us-chicago-1 endpoint.
   */
  serviceEndpoint?: string;
  /** Authentication method. Defaults to `API_KEY`. */
  authType?: OciAuthType;
  /** Config profile for `API_KEY` auth. Defaults to `DEFAULT`. */
  authProfile?: string;
  /** OCI config file for `API_KEY` auth. Defaults to `~/.oci/config`. */
  authFileLocation?: string;
  /**
   * Maximum number of tokens to generate. Defaults to 2048, and a request
   * whose config sets `maxOutputTokens` overrides it.
   */
  maxTokens?: number;
  /**
   * Reasoning-token budget, applied to every request this instance makes.
   * Reasoning models honour it and other models ignore it. It is the largest
   * cost knob for a reasoning model.
   */
  reasoningEffort?: OciReasoningEffort;
}

/** The `oci-generativeaiinference` module, loaded on first use. */
type OciInferenceModule = typeof import('oci-generativeaiinference');

/** The `oci-common` module, loaded on first use. */
type OciCommonModule = typeof import('oci-common');

/** The runtime `models` namespace of {@link OciInferenceModule}. */
type OciModels = OciInferenceModule['models'];

/** The OCI SDK pieces a chat request needs. */
interface OciSdk {
  client: GenerativeAiInferenceClient;
  ociModels: OciModels;
}

/** What `GenerativeAiInferenceClient.chat()` can return. */
type OciChatResult = responses.ChatResponse | ReadableStream<Uint8Array> | null;

/** The response formats an OCI generic chat request accepts. */
type OciResponseFormat = NonNullable<
  models.GenericChatRequest['responseFormat']
>;

/** The media-carrying fields shared by `Part` and `FunctionResponsePart`. */
interface MediaPart {
  inlineData?: {data?: string; mimeType?: string};
  fileData?: {fileUri?: string; mimeType?: string};
}

/** One tool-call delta of an OCI Generative AI event stream. */
interface OciToolCallDelta {
  index?: number;
  id?: string;
  name?: string;
  arguments?: string;
}

/** The token counts an OCI Generative AI event stream reports. */
interface OciUsage {
  promptTokens?: number;
  completionTokens?: number;
  completionTokensDetails?: {reasoningTokens?: number};
}

/** One `data:` payload of an OCI Generative AI event stream. */
interface OciStreamChunk {
  message?: {
    content?: Array<{type?: string; text?: string}>;
    toolCalls?: OciToolCallDelta[];
  };
  usage?: OciUsage;
}

/** A tool call assembled from one or more stream events. */
interface StreamedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Integration with the models hosted on OCI Generative AI, including Meta
 * Llama, Google Gemini, Google Gemma and the other models that speak OCI's
 * generic chat format.
 *
 * The OCI SDK is an optional peer dependency loaded on the first request, so
 * importing ADK does not load it. Install it before use:
 *
 * ```sh
 * npm install oci-common oci-generativeaiinference
 * ```
 *
 * @example
 * ```ts
 * import {LlmAgent, OciGenAiLlm} from '@google/adk';
 *
 * const agent = new LlmAgent({
 *   name: 'oci_agent',
 *   model: new OciGenAiLlm({
 *     model: 'google.gemini-2.5-flash',
 *     compartmentId: 'ocid1.compartment.oc1..example',
 *   }),
 * });
 * ```
 */
export class OciGenAiLlm extends BaseLlm {
  private readonly endpointId?: string;
  private readonly compartmentId?: string;
  private readonly serviceEndpoint?: string;
  private readonly authType: OciAuthType;
  private readonly authProfile: string;
  private readonly authFileLocation: string;
  private readonly maxTokens: number;
  private readonly reasoningEffort?: OciReasoningEffort;
  private sdk?: Promise<OciSdk>;

  /** The model name patterns this provider claims, as adk-python lists them. */
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
    model,
    endpointId,
    compartmentId,
    serviceEndpoint,
    authType,
    authProfile,
    authFileLocation,
    maxTokens,
    reasoningEffort,
  }: OciGenAiLlmParams) {
    super({model});
    this.endpointId = endpointId;
    this.compartmentId = compartmentId;
    this.serviceEndpoint = serviceEndpoint;
    this.authType = authType ?? DEFAULT_AUTH_TYPE;
    this.authProfile = authProfile ?? DEFAULT_AUTH_PROFILE;
    this.authFileLocation = authFileLocation ?? DEFAULT_AUTH_FILE_LOCATION;
    this.maxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
    this.reasoningEffort = reasoningEffort;
  }

  /**
   * Sends one chat request to OCI Generative AI.
   *
   * `abortSignal` stops a streaming response; OCI's client takes no signal, so
   * a non-streaming call runs to completion.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const {client, ociModels} = await this.getSdk();
    const chatDetails = this.buildChatDetails(llmRequest, ociModels, stream);
    logger.debug(
      `Sending a request to OCI Generative AI: model=${this.model}, stream=${stream}`,
    );
    const result = await client.chat({chatDetails});

    if (stream) {
      yield* streamLlmResponses(requireEventStream(result), abortSignal);
      return;
    }
    yield ociResponseToLlmResponse(requireChatResponse(result).chatResult);
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'OciGenAiLlm does not support live connections: OCI Generative AI has no bidirectional API.',
    );
  }

  /**
   * Loads the OCI SDK and builds the client once per instance. A failed build
   * is not cached, so a transient one — an unreadable config file, a metadata
   * service blip — does not disable the instance for the rest of its life.
   */
  private getSdk(): Promise<OciSdk> {
    this.sdk ??= this.loadSdk().catch((error: unknown) => {
      this.sdk = undefined;
      throw error;
    });
    return this.sdk;
  }

  private async loadSdk(): Promise<OciSdk> {
    let inference: OciInferenceModule;
    let common: OciCommonModule;
    try {
      [inference, common] = await Promise.all([
        import('oci-generativeaiinference'),
        import('oci-common'),
      ]);
    } catch (cause: unknown) {
      throw new Error(
        'OciGenAiLlm needs the OCI SDK. Install it with: npm install oci-common oci-generativeaiinference',
        {cause},
      );
    }

    const client = new inference.GenerativeAiInferenceClient({
      authenticationDetailsProvider: await this.buildAuthProvider(common),
    });
    client.endpoint = this.resolveServiceEndpoint();
    return {client, ociModels: inference.models};
  }

  private buildAuthProvider(
    common: OciCommonModule,
  ): Promise<AuthenticationDetailsProvider> | AuthenticationDetailsProvider {
    switch (this.authType) {
      case 'INSTANCE_PRINCIPAL':
        return new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
      case 'RESOURCE_PRINCIPAL':
        return common.ResourcePrincipalAuthenticationDetailsProvider.builder();
      default:
        return new common.ConfigFileAuthenticationDetailsProvider(
          this.authFileLocation,
          this.authProfile,
        );
    }
  }

  private buildChatDetails(
    llmRequest: LlmRequest,
    ociModels: OciModels,
    isStream: boolean,
  ): models.ChatDetails {
    const config = llmRequest.config;
    const messages: models.Message[] = [];
    const instruction = config && extractSystemInstruction(config);
    if (instruction) {
      const systemMessage: models.SystemMessage = {
        role: OciRole.System,
        content: [textContent(instruction)],
      };
      messages.push(systemMessage);
    }
    for (const content of llmRequest.contents) {
      messages.push(...contentToOciMessages(content));
    }

    const chatRequest: models.GenericChatRequest = {
      apiFormat: GENERIC_API_FORMAT,
      messages,
      maxTokens: this.maxTokens,
    };
    applyGenerationConfig(chatRequest, config);

    if (this.reasoningEffort) {
      chatRequest.reasoningEffort = toReasoningEffort(
        ociModels,
        this.reasoningEffort,
      );
    }
    const tools = functionDeclarationsOf(config).map(
      functionDeclarationToOciTool,
    );
    if (tools.length) {
      chatRequest.tools = tools;
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

  private buildServingMode(): models.ChatDetails['servingMode'] {
    const endpointId = this.endpointId || process.env[ENDPOINT_ID_ENV_VAR];
    if (endpointId) {
      const dedicated: models.DedicatedServingMode = {
        servingType: OciServingType.Dedicated,
        endpointId,
      };
      return dedicated;
    }
    const onDemand: models.OnDemandServingMode = {
      servingType: OciServingType.OnDemand,
      modelId: this.model,
    };
    return onDemand;
  }

  private resolveCompartmentId(): string {
    const compartmentId =
      this.compartmentId || process.env[COMPARTMENT_ID_ENV_VAR];
    if (!compartmentId) {
      throw new Error(
        `compartmentId must be set on OciGenAiLlm or in the ${COMPARTMENT_ID_ENV_VAR} environment variable.`,
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

/** Maps an ADK content role onto the OCI message role it produces. */
export function toOciRole(role?: string): OciRole.Assistant | OciRole.User {
  return role === 'model' || role === 'assistant'
    ? OciRole.Assistant
    : OciRole.User;
}

/**
 * Converts one ADK content into the OCI messages it maps to.
 *
 * A single content can carry text, media, tool calls and tool results at once,
 * and OCI models each differently: every tool result becomes its own
 * `ToolMessage`, and the rest becomes one assistant or user message.
 */
export function contentToOciMessages(content: Content): models.Message[] {
  const textParts: string[] = [];
  const mediaBlocks: models.ChatContent[] = [];
  const toolCalls: models.FunctionCall[] = [];
  const toolResults: Array<{callId: string; text: string}> = [];

  for (const part of content.parts ?? []) {
    if (part.text) {
      textParts.push(part.text);
    } else if (part.functionCall) {
      toolCalls.push({
        id: part.functionCall.id ?? '',
        type: FUNCTION_TYPE,
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    } else if (part.functionResponse) {
      const functionResponse = part.functionResponse;
      toolResults.push({
        callId: functionResponse.id ?? '',
        text: JSON.stringify(functionResponse.response ?? {}),
      });
      for (const responsePart of functionResponse.parts ?? []) {
        mediaBlocks.push(...mediaBlocksForPart(responsePart));
      }
    } else if (part.inlineData || part.fileData) {
      mediaBlocks.push(...mediaBlocksForPart(part));
    }
  }

  const messages: models.Message[] = toolResults.map(
    ({callId, text}): models.ToolMessage => ({
      role: OciRole.Tool,
      toolCallId: callId,
      content: [textContent(text)],
    }),
  );
  if (
    messages.length &&
    !textParts.length &&
    !mediaBlocks.length &&
    !toolCalls.length
  ) {
    return messages;
  }

  const text = textParts.length ? [textContent(textParts.join('\n'))] : [];
  if (toOciRole(content.role) === OciRole.Assistant) {
    const assistant: models.AssistantMessage = {
      role: OciRole.Assistant,
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    };
    messages.push(assistant);
    return messages;
  }

  const userContent = [...text, ...mediaBlocks];
  // Without the emptiness check a content holding only tool results would gain
  // a trailing empty user message.
  if (!messages.length || userContent.length) {
    const user: models.UserMessage = {
      role: OciRole.User,
      content: userContent,
    };
    messages.push(user);
  }
  return messages;
}

/**
 * Converts the media a part carries into OCI content blocks, empty when the
 * part carries none.
 */
export function mediaBlocksForPart(part: MediaPart): models.ChatContent[] {
  let url: string | undefined;
  let mimeType: string | undefined;

  if (part.inlineData?.data !== undefined) {
    // `inlineData.data` is base64 already; encoding it again corrupts it.
    mimeType = part.inlineData.mimeType || DEFAULT_MEDIA_MIME_TYPE;
    url = `data:${mimeType};base64,${part.inlineData.data}`;
  } else if (part.fileData?.fileUri) {
    url = part.fileData.fileUri;
    mimeType = part.fileData.mimeType;
  }

  if (!url) {
    return [];
  }

  switch ((mimeType ?? '').split('/')[0].toLowerCase()) {
    case 'image': {
      const image: models.ImageContent = {
        type: OciContentType.Image,
        imageUrl: {url},
      };
      return [image];
    }
    case 'audio': {
      const audio: models.AudioContent = {
        type: OciContentType.Audio,
        audioUrl: {url},
      };
      return [audio];
    }
    case 'video': {
      const video: models.VideoContent = {
        type: OciContentType.Video,
        videoUrl: {url},
      };
      return [video];
    }
    default: {
      const document: models.DocumentContent = {
        type: OciContentType.Document,
        documentUrl: {url},
      };
      return [document];
    }
  }
}

/** Converts an ADK function declaration into an OCI tool definition. */
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
 * Renders the parameter schema of a function declaration as JSON Schema, which
 * is what OCI expects in `FunctionDefinition.parameters`.
 */
function toolParameters(fn: FunctionDeclaration): unknown {
  if (fn.parametersJsonSchema) {
    return fn.parametersJsonSchema;
  }
  const properties = fn.parameters?.properties;
  if (!properties) {
    return {type: 'object', properties: {}};
  }
  const converted: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    converted[name] = toJsonSchema(property);
  }
  const parameters: Record<string, unknown> = {
    type: 'object',
    properties: converted,
  };
  if (fn.parameters?.required?.length) {
    parameters['required'] = fn.parameters.required;
  }
  return parameters;
}

/** Maps the response settings of a request onto an OCI response format. */
export function buildResponseFormat(
  config: GenerateContentConfig,
): OciResponseFormat | undefined {
  if (isSchemaObject(config.responseSchema)) {
    const schema = toOciJsonSchema(config.responseSchema);
    const jsonSchema: models.JsonSchemaResponseFormat = {
      type: OciResponseFormatType.JsonSchema,
      jsonSchema: {
        name: stringField(schema, 'title') ?? DEFAULT_RESPONSE_SCHEMA_NAME,
        description: stringField(schema, 'description'),
        schema,
        isStrict: true,
      },
    };
    return jsonSchema;
  }

  switch (config.responseMimeType) {
    case 'application/json': {
      const jsonObject: models.JsonObjectResponseFormat = {
        type: OciResponseFormatType.JsonObject,
      };
      return jsonObject;
    }
    case 'text/plain': {
      const text: models.TextResponseFormat = {
        type: OciResponseFormatType.Text,
      };
      return text;
    }
    default:
      return undefined;
  }
}

/** Converts a non-streaming OCI chat result into an ADK response. */
export function ociResponseToLlmResponse(
  chatResult: models.ChatResult,
): LlmResponse {
  const chatResponse = chatResult.chatResponse;
  if (!('choices' in chatResponse)) {
    throw new Error(
      `OCI Generative AI answered a generic chat request in the ${chatResponse.apiFormat} format.`,
    );
  }

  const parts: Part[] = [];
  const message = chatResponse.choices[0]?.message;
  for (const block of message?.content ?? []) {
    if (isTextContent(block) && block.text) {
      parts.push({text: block.text});
    }
  }
  if (message && 'toolCalls' in message) {
    for (const toolCall of message.toolCalls ?? []) {
      if (isFunctionCall(toolCall)) {
        parts.push(functionCallPart(toolCall));
      }
    }
  }

  return {
    content: {role: 'model', parts},
    usageMetadata: toUsageMetadata(chatResponse.usage),
  };
}

/**
 * Yields one partial response per text delta, then one final response holding
 * the whole text, the assembled tool calls and the token usage.
 */
async function* streamLlmResponses(
  stream: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): AsyncGenerator<LlmResponse, void> {
  const toolCalls = new Map<number, StreamedToolCall>();
  let text = '';
  let usage: OciUsage | undefined;

  for await (const data of readSseData(stream, abortSignal)) {
    if (data === STREAM_DONE_SENTINEL) {
      break;
    }
    const chunk = parseStreamChunk(data);
    if (chunk?.usage) {
      usage = chunk.usage;
      continue;
    }
    const message = chunk?.message;
    if (!message) {
      continue;
    }
    // A stream event is untrusted input, so a field of the wrong shape has to
    // be skipped rather than iterated.
    for (const block of asArray(message.content)) {
      if (block.type !== OciContentType.Text || !block.text) {
        continue;
      }
      text += block.text;
      yield {
        content: {role: 'model', parts: [{text: block.text}]},
        partial: true,
      };
    }
    accumulateToolCalls(toolCalls, asArray(message.toolCalls));
  }

  yield {
    content: {role: 'model', parts: streamedParts(text, toolCalls)},
    usageMetadata: toUsageMetadata(usage),
    partial: false,
  };
}

/**
 * Merges the tool-call deltas of one event into the calls assembled so far.
 * OCI may split a call's arguments over several events.
 */
function accumulateToolCalls(
  assembled: Map<number, StreamedToolCall>,
  deltas: OciToolCallDelta[],
): void {
  deltas.forEach((delta, position) => {
    const index = delta.index ?? position;
    const call = assembled.get(index) ?? {id: '', name: '', arguments: ''};
    if (delta.id) {
      call.id = delta.id;
    }
    if (delta.name) {
      call.name = delta.name;
    }
    if (delta.arguments) {
      call.arguments += delta.arguments;
    }
    assembled.set(index, call);
  });
}

/** Builds the parts of the final response of a stream. */
function streamedParts(
  text: string,
  toolCalls: Map<number, StreamedToolCall>,
): Part[] {
  const parts: Part[] = text ? [{text}] : [];
  for (const call of [...toolCalls.values()].sort(byName)) {
    parts.push(functionCallPart(call));
  }
  return parts;
}

/**
 * Orders assembled tool calls by name. The comparison is on code units, as
 * adk-python's sort is; `localeCompare` would order them differently.
 */
function byName(left: StreamedToolCall, right: StreamedToolCall): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** The value when it really is a list, and an empty list otherwise. */
function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/** Parses one event payload, or skips it when the payload is not JSON. */
function parseStreamChunk(data: string): OciStreamChunk | undefined {
  try {
    return JSON.parse(data);
  } catch {
    logger.debug(`Could not parse an OCI Generative AI stream event: ${data}`);
    return undefined;
  }
}

/** Parses tool-call arguments, falling back to an empty object. */
function parseJsonObject(source?: string): Record<string, unknown> {
  if (!source) {
    return {};
  }
  try {
    return JSON.parse(source);
  } catch {
    logger.debug(`Could not parse OCI tool-call arguments: ${source}`);
    return {};
  }
}

/** Copies the sampling and decoding settings of a request onto the payload. */
function applyGenerationConfig(
  chatRequest: models.GenericChatRequest,
  config?: GenerateContentConfig,
): void {
  if (!config) {
    return;
  }
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
 * Reads the reasoning effort back off the SDK's own enum, which is the only
 * source of a value the SDK's types accept.
 */
function toReasoningEffort(
  ociModels: OciModels,
  effort: OciReasoningEffort,
): models.GenericChatRequest.ReasoningEffort | undefined {
  return Object.values(ociModels.GenericChatRequest.ReasoningEffort).find(
    (member) => member === effort,
  );
}

/** Returns the function declarations of a request, as adk-python narrows them. */
function functionDeclarationsOf(
  config?: GenerateContentConfig,
): FunctionDeclaration[] {
  const firstTool = config?.tools?.[0];
  if (firstTool && 'functionDeclarations' in firstTool) {
    return firstTool.functionDeclarations ?? [];
  }
  return [];
}

function textContent(text: string): models.TextContent {
  return {type: OciContentType.Text, text};
}

/**
 * Builds a function-call part from a tool call of a response or a stream. OCI
 * gives every tool call an id, and a streamed call that has not carried one
 * yet holds the empty string, so the part always names one.
 */
function functionCallPart(call: {
  id: string;
  name?: string;
  arguments?: string;
}): Part {
  return {
    functionCall: {
      id: call.id,
      name: call.name,
      args: parseJsonObject(call.arguments),
    },
  };
}

function toUsageMetadata(
  usage?: OciUsage,
): GenerateContentResponseUsageMetadata {
  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  return {
    promptTokenCount: promptTokens,
    candidatesTokenCount: completionTokens,
    totalTokenCount: promptTokens + completionTokens,
    thoughtsTokenCount:
      usage?.completionTokensDetails?.reasoningTokens || undefined,
  };
}

function stringField(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/** Type guard for the OCI text content block. */
function isTextContent(block: models.ChatContent): block is models.TextContent {
  return block.type === OciContentType.Text;
}

/** Type guard for the OCI function tool call. */
function isFunctionCall(call: models.ToolCall): call is models.FunctionCall {
  return call.type === FUNCTION_TYPE;
}

/**
 * Narrows `GenerateContentConfig.responseSchema`, which genai types as
 * `unknown`. Every schema form ADK accepts is an object.
 */
function isSchemaObject(schema: unknown): schema is Record<string, unknown> {
  return typeof schema === 'object' && schema !== null;
}

/**
 * True when a schema is written in the genai dialect, which names its types in
 * upper case, rather than as JSON Schema.
 */
function isGenaiSchema(
  schema: Record<string, unknown>,
): schema is Record<string, unknown> & Schema {
  const type = schema['type'];
  return typeof type === 'string' && GENAI_SCHEMA_TYPES.has(type);
}

/**
 * Renders a response schema as the JSON Schema that OCI reads.
 *
 * A Zod type or a genai `Schema` is converted. A schema already written as
 * JSON Schema passes through unchanged, as adk-python's `dict` branch does:
 * converting it would strip every `type`, because the converter only knows the
 * genai dialect's upper-case type names.
 */
function toOciJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return isZodSchema(schema) || isGenaiSchema(schema)
    ? toJsonSchema(schema)
    : schema;
}

function requireChatResponse(result: OciChatResult): responses.ChatResponse {
  if (!result || !('chatResult' in result)) {
    throw new Error(
      'OCI Generative AI returned no chat result for a non-streaming request.',
    );
  }
  return result;
}

function requireEventStream(result: OciChatResult): ReadableStream<Uint8Array> {
  if (!result || 'chatResult' in result) {
    throw new Error(
      'OCI Generative AI returned no event stream for a streaming request.',
    );
  }
  return result;
}
