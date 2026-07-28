/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Blob,
  Content,
  FunctionCall,
  FunctionResponse,
  GenerateContentResponseUsageMetadata,
  Part,
} from '@google/genai';

import {AsyncQueue} from '../utils/async_queue.js';
import {logger} from '../utils/logger.js';

import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmResponse} from './llm_response.js';

/**
 * Minimal transport surface the connection needs to send frames and close the
 * socket. Keeping it decoupled from the concrete `WebSocket` lets the
 * connection be unit-tested with a mock, mirroring how `GeminiLlmConnection`
 * takes an injected `Session`.
 */
export interface RealtimeWebSocketLike {
  send(data: string): void;
  close(): void;
}

/**
 * A loosely-typed OpenAI Realtime server event (a JSON object decoded from the
 * socket). Every event carries a `type` discriminator; the remaining fields
 * vary by event and are read defensively.
 */
export type OpenAiRealtimeServerEvent = {type: string} & Record<
  string,
  unknown
>;

/** Client event `type` strings sent to the socket. */
const CLIENT_EVENT_CONVERSATION_ITEM_CREATE = 'conversation.item.create';
const CLIENT_EVENT_INPUT_AUDIO_BUFFER_APPEND = 'input_audio_buffer.append';
const CLIENT_EVENT_RESPONSE_CREATE = 'response.create';

/** Realtime conversation item `type` strings. */
const ITEM_TYPE_MESSAGE = 'message';
const ITEM_TYPE_FUNCTION_CALL = 'function_call';
const ITEM_TYPE_FUNCTION_CALL_OUTPUT = 'function_call_output';

/**
 * MIME type reported for model output audio chunks. The Realtime API streams
 * PCM16 audio by default; the actual format is negotiated in `session.update`.
 */
const REALTIME_AUDIO_MIME = 'audio/pcm';

/**
 * A live model connection that speaks the OpenAI Realtime WebSocket wire format.
 *
 * It translates ADK `Content`/`Blob` into Realtime client events on the way out
 * and Realtime server events into {@link LlmResponse}s on the way in. It is the
 * OpenAI counterpart of `GeminiLlmConnection` and is created by
 * `ChatCompletionsLlm.connect()`.
 */
export class OpenAiRealtimeConnection implements BaseLlmConnection {
  constructor(
    private readonly ws: RealtimeWebSocketLike,
    private readonly modelVersion: string | undefined,
    private readonly messageQueue: AsyncQueue<OpenAiRealtimeServerEvent>,
  ) {}

  /**
   * Sends the conversation history to the model.
   *
   * Emits one `conversation.item.create` per Realtime item derived from the
   * history, then a single `response.create` to elicit a reply, but only when
   * the last turn is from the user (matching the `BaseLlmConnection` contract).
   * When the history yields no sendable items, nothing is sent.
   *
   * @param history The conversation history to send to the model.
   */
  async sendHistory(history: Content[]): Promise<void> {
    const items = history.flatMap((content) => contentToRealtimeItems(content));
    if (items.length === 0) {
      logger.debug('OpenAiRealtimeConnection.sendHistory: no content to send.');
      return;
    }
    for (const item of items) {
      this.sendClientEvent({type: CLIENT_EVENT_CONVERSATION_ITEM_CREATE, item});
    }
    if (history[history.length - 1]?.role === 'user') {
      this.sendClientEvent({type: CLIENT_EVENT_RESPONSE_CREATE});
    }
  }

  /**
   * Sends a single turn to the model and requests a response.
   *
   * Function responses become `function_call_output` items; any other parts
   * become a single message item. A `response.create` is always sent afterwards
   * so the model replies immediately.
   *
   * @param content The content to send to the model.
   */
  async sendContent(content: Content): Promise<void> {
    if (!content.parts) {
      throw new Error('Content must have parts.');
    }
    for (const item of contentToRealtimeItems(content)) {
      this.sendClientEvent({type: CLIENT_EVENT_CONVERSATION_ITEM_CREATE, item});
    }
    this.sendClientEvent({type: CLIENT_EVENT_RESPONSE_CREATE});
  }

  /**
   * Streams a chunk of realtime input to the model.
   *
   * The Realtime input buffer is audio-only, so non-audio blobs (e.g. video
   * frames) are dropped with a warning.
   *
   * @param blob The blob to send to the model.
   */
  async sendRealtime(blob: Blob): Promise<void> {
    if (!blob.mimeType?.startsWith('audio/')) {
      logger.warn(
        'OpenAiRealtimeConnection.sendRealtime: dropping non-audio blob with ' +
          `mime type '${blob.mimeType}'; Realtime input is audio-only.`,
      );
      return;
    }
    this.sendClientEvent({
      type: CLIENT_EVENT_INPUT_AUDIO_BUFFER_APPEND,
      audio: blob.data,
    });
  }

  /**
   * Receives model responses until the underlying socket closes.
   *
   * Iterates the message queue fed by the socket callbacks, translating each
   * server event into zero or more {@link LlmResponse}s. A socket error surfaces
   * as a rejection from the generator; a socket close ends it.
   *
   * @return A generator of {@link LlmResponse}.
   */
  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    let accumulatedText = '';
    for await (const event of this.messageQueue) {
      logger.debug('OpenAiRealtimeConnection received event:', event.type);
      const result = translateServerEvent(
        event,
        this.modelVersion,
        accumulatedText,
      );
      accumulatedText = result.accumulatedText;
      for (const response of result.responses) {
        yield response;
      }
    }
  }

  /** Closes the underlying socket, which ends any in-flight `receive()`. */
  async close(): Promise<void> {
    this.ws.close();
  }

  private sendClientEvent(event: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(event));
  }
}

/**
 * Converts an ADK `Content` into the Realtime conversation items it maps to.
 *
 * A content may expand into several items: each function response becomes a
 * `function_call_output` item, each function call becomes a `function_call`
 * item, and any remaining message parts (text/audio/image) are collected into a
 * single `message` item. Returns an empty array when nothing is sendable.
 */
export function contentToRealtimeItems(
  content: Content,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  const messageContent: Array<Record<string, unknown>> = [];

  for (const part of content.parts ?? []) {
    if (part.functionResponse) {
      items.push(functionResponseToItem(part.functionResponse));
    } else if (part.functionCall) {
      items.push(functionCallToItem(part.functionCall));
    } else {
      const entry = partToMessageContent(part);
      if (entry) {
        messageContent.push(entry);
      }
    }
  }

  if (messageContent.length > 0) {
    items.push({
      type: ITEM_TYPE_MESSAGE,
      role: toRealtimeRole(content.role),
      content: messageContent,
    });
  }
  return items;
}

/** Maps an ADK role to a Realtime role (`model` -> `assistant`). */
function toRealtimeRole(role?: string): string {
  return role === 'model' ? 'assistant' : (role ?? 'user');
}

/** Builds a Realtime message content entry from a single message part. */
function partToMessageContent(part: Part): Record<string, unknown> | undefined {
  if (part.text !== undefined) {
    return {type: 'input_text', text: part.text};
  }
  const mimeType = part.inlineData?.mimeType;
  if (mimeType?.startsWith('audio/')) {
    return {type: 'input_audio', audio: part.inlineData!.data};
  }
  if (mimeType?.startsWith('image/')) {
    return {
      type: 'input_image',
      image_url: `data:${mimeType};base64,${part.inlineData!.data}`,
    };
  }
  if (part.fileData?.fileUri) {
    return {type: 'input_image', image_url: part.fileData.fileUri};
  }
  logger.debug('OpenAiRealtimeConnection: skipping unsupported content part.');
  return undefined;
}

/** Builds a `function_call_output` item from a function response. */
function functionResponseToItem(
  functionResponse: FunctionResponse,
): Record<string, unknown> {
  return {
    type: ITEM_TYPE_FUNCTION_CALL_OUTPUT,
    call_id: functionResponse.id,
    output: JSON.stringify(functionResponse.response ?? {}),
  };
}

/** Builds a `function_call` item from a function call. */
function functionCallToItem(
  functionCall: FunctionCall,
): Record<string, unknown> {
  return {
    type: ITEM_TYPE_FUNCTION_CALL,
    name: functionCall.name,
    call_id: functionCall.id,
    arguments: JSON.stringify(functionCall.args ?? {}),
  };
}

/** The result of translating one server event. */
interface TranslateResult {
  /** Responses to yield for this event (may be empty). */
  responses: LlmResponse[];
  /** The output-text accumulator carried to the next event. */
  accumulatedText: string;
}

/**
 * Translates one OpenAI Realtime server event into the {@link LlmResponse}s a
 * runner consumes. Pure: text spanning multiple deltas is threaded through
 * `accumulatedText` rather than held as instance state. Unrecognized events
 * yield nothing.
 */
function translateServerEvent(
  event: OpenAiRealtimeServerEvent,
  modelVersion: string | undefined,
  accumulatedText: string,
): TranslateResult {
  const withModel = (response: LlmResponse): LlmResponse => ({
    ...response,
    modelVersion,
  });
  const delta = (event['delta'] as string | undefined) ?? '';

  switch (event.type) {
    case 'response.output_text.delta':
    case 'response.text.delta':
      return {
        responses: [
          withModel({
            partial: true,
            content: {role: 'model', parts: [{text: delta}]},
          }),
        ],
        accumulatedText: accumulatedText + delta,
      };
    case 'response.output_text.done': {
      const text =
        accumulatedText || (event['text'] as string | undefined) || '';
      return {
        responses: [
          withModel({
            partial: false,
            content: {role: 'model', parts: [{text}]},
          }),
        ],
        accumulatedText: '',
      };
    }
    case 'response.output_audio.delta':
    case 'response.audio.delta':
      return {
        responses: [
          withModel({
            content: {
              role: 'model',
              parts: [
                {inlineData: {mimeType: REALTIME_AUDIO_MIME, data: delta}},
              ],
            },
          }),
        ],
        accumulatedText,
      };
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      return {
        responses: [
          withModel({
            partial: true,
            outputTranscription: {text: delta, finished: false},
          }),
        ],
        accumulatedText,
      };
    case 'conversation.item.input_audio_transcription.delta':
      return {
        responses: [
          withModel({
            partial: true,
            inputTranscription: {text: delta, finished: false},
          }),
        ],
        accumulatedText,
      };
    case 'conversation.item.input_audio_transcription.completed':
      return {
        responses: [
          withModel({
            partial: false,
            inputTranscription: {
              text: (event['transcript'] as string | undefined) ?? '',
              finished: true,
            },
          }),
        ],
        accumulatedText,
      };
    case 'response.done':
      return {
        responses: responsesFromResponseDone(event).map(withModel),
        accumulatedText,
      };
    case 'input_audio_buffer.speech_started':
      return {responses: [withModel({interrupted: true})], accumulatedText};
    case 'error':
      return {responses: [withModel(errorResponse(event))], accumulatedText};
    default:
      logger.debug(
        `OpenAiRealtimeConnection: ignoring server event '${event.type}'.`,
      );
      return {responses: [], accumulatedText};
  }
}

/**
 * Builds the responses for a `response.done` event: one function-call response
 * per emitted `function_call` output item, followed by a `turnComplete` marker
 * that carries usage metadata when present.
 */
function responsesFromResponseDone(
  event: OpenAiRealtimeServerEvent,
): LlmResponse[] {
  const responses: LlmResponse[] = [];
  const response = (event['response'] as Record<string, unknown>) ?? {};
  const output = (response['output'] as Array<Record<string, unknown>>) ?? [];

  for (const item of output) {
    if (item['type'] === ITEM_TYPE_FUNCTION_CALL) {
      responses.push({
        content: {role: 'model', parts: [functionCallItemToPart(item)]},
      });
    }
  }

  const turnComplete: LlmResponse = {turnComplete: true};
  const usage = response['usage'] as Record<string, unknown> | undefined;
  if (usage) {
    turnComplete.usageMetadata = realtimeUsageToMetadata(usage);
  }
  responses.push(turnComplete);
  return responses;
}

/** Converts a Realtime `function_call` output item into a function-call part. */
function functionCallItemToPart(item: Record<string, unknown>): Part {
  const functionCall: FunctionCall = {
    id: item['call_id'] as string | undefined,
    name: item['name'] as string | undefined,
    args: parseFunctionArguments(item['arguments'] as string | undefined),
  };
  return {functionCall};
}

/** Parses a function-call `arguments` JSON string into an args object. */
function parseFunctionArguments(
  argumentsJson: string | undefined,
): Record<string, unknown> {
  if (!argumentsJson) {
    return {};
  }
  try {
    return JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse arguments: ${argumentsJson}`);
  }
}

/** Maps a Realtime `error` event to an error {@link LlmResponse}. */
function errorResponse(event: OpenAiRealtimeServerEvent): LlmResponse {
  const error = (event['error'] as Record<string, unknown>) ?? event;
  return {
    errorCode: String(error['code'] ?? 'UNKNOWN'),
    errorMessage: error['message'] as string | undefined,
  };
}

/** Maps a Realtime `response.usage` object to genai usage metadata. */
function realtimeUsageToMetadata(
  usage: Record<string, unknown>,
): GenerateContentResponseUsageMetadata {
  return {
    promptTokenCount: (usage['input_tokens'] as number) ?? 0,
    candidatesTokenCount: (usage['output_tokens'] as number) ?? 0,
    totalTokenCount: (usage['total_tokens'] as number) ?? 0,
  };
}
