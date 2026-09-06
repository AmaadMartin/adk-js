/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Blob,
  Content,
  FunctionResponse,
  LiveServerMessage,
  Session,
} from '@google/genai';

import {LiveResponseAggregator} from '../utils/live_connection_utils.js';
import {logger} from '../utils/logger.js';
import {
  isGemini35LiveTranslate,
  isGemini3xFlashLive,
  isGemini3xLive,
} from '../utils/model_name.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

import {BaseLlmConnection, RealtimeInput} from './base_llm_connection.js';
import {LlmResponse} from './llm_response.js';

/** The fields of a `LiveClientRealtimeInput`. */
const REALTIME_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'activityEnd',
  'activityStart',
  'audio',
  'audioStreamEnd',
  'mediaChunks',
  'text',
  'video',
]);

/**
 * Returns whether a realtime input is a media blob rather than a control
 * signal.
 *
 * `Blob` and `LiveClientRealtimeInput` share no field names, so the presence of
 * any `Blob` field identifies the input exactly.
 */
function isBlobInput(input: RealtimeInput): input is Blob {
  return 'mimeType' in input || 'data' in input || 'displayName' in input;
}

/**
 * Returns whether every field of the input belongs to
 * `LiveClientRealtimeInput`. An input with an unknown field is not a realtime
 * input at all, and the caller rejects it.
 */
function isRealtimeControlInput(input: RealtimeInput): boolean {
  return Object.keys(input).every((field) => REALTIME_INPUT_FIELDS.has(field));
}

/** Describes a rejected input for the error message. */
function describeInput(input: unknown): string {
  if (input === null) {
    return 'null';
  }
  if (typeof input !== 'object') {
    return typeof input;
  }
  return `object with fields [${Object.keys(input).join(', ')}]`;
}

/** The Gemini model connection. */
export class GeminiLlmConnection implements BaseLlmConnection {
  /**
   * @param geminiSession The live session to send on and receive from.
   * @param modelVersion The version of the model behind the session.
   * @param messageQueue The queue of server messages {@link receive} reads.
   * @param apiBackend The Google backend the session was opened against. The
   *     connection reports it for callers that behave differently on Vertex AI
   *     and on the Gemini API.
   */
  constructor(
    private readonly geminiSession: Session,
    private readonly modelVersion?: string,
    private readonly messageQueue?: AsyncIterable<LiveServerMessage>,
    readonly apiBackend: GoogleLLMVariant = GoogleLLMVariant.VERTEX_AI,
  ) {}

  /**
   * Sends the conversation history to the gemini model.
   *
   * You call this method right after setting up the model connection.
   * The model will respond if the last content is from user, otherwise it will
   * wait for new user input before responding.
   *
   * @param history The conversation history to send to the model.
   */
  async sendHistory(history: Content[]): Promise<void> {
    // We ignore any audio from user during the agent transfer phase.
    const contents = history.filter(
      (content) => content.parts && content.parts[0]?.text,
    );

    if (contents.length > 0) {
      const isGemini3x = isGemini3xFlashLive(this.modelVersion);
      this.geminiSession.sendClientContent({
        turns: contents,
        turnComplete: isGemini3x
          ? true
          : contents[contents.length - 1].role === 'user',
      });
    } else {
      logger.info('no content is sent');
    }
  }

  /**
   * Sends a user content to the gemini model.
   *
   * The model will respond immediately upon receiving the content.
   * If you send function responses, all parts in the content should be function
   * responses.
   *
   * @param content The content to send to the model.
   */
  async sendContent(content: Content): Promise<void> {
    if (!content.parts) {
      throw new Error('Content must have parts.');
    }
    if (content.parts[0].functionResponse) {
      // All parts have to be function responses.
      const functionResponses = content.parts
        .map((part) => part.functionResponse)
        .filter((fr): fr is FunctionResponse => !!fr);
      logger.debug('Sending LLM function response:', functionResponses);
      this.geminiSession.sendToolResponse({
        functionResponses,
      });
    } else {
      logger.debug('Sending LLM new content', content);
      const isGemini3x = isGemini3xFlashLive(this.modelVersion);
      if (isGemini3x && content.parts.length === 1 && content.parts[0].text) {
        logger.debug('Using sendRealtimeInput for Gemini 3.x text input');
        this.geminiSession.sendRealtimeInput({text: content.parts[0].text});
      } else {
        this.geminiSession.sendClientContent({
          turns: [content],
          turnComplete: true,
        });
      }
    }
  }

  /**
   * Sends a chunk of audio, a frame of video, or a realtime control signal to
   * the model.
   *
   * @param input The blob or control signal to send to the model.
   * @throws An `Error` when the input is neither a `Blob` nor a
   *     `LiveClientRealtimeInput`.
   */
  async sendRealtime(input: RealtimeInput): Promise<void> {
    if (!input || typeof input !== 'object') {
      throw new Error(`Unsupported input type: ${describeInput(input)}`);
    }

    if (isBlobInput(input)) {
      logger.debug('Sending LLM Blob:', input);
      this.sendBlob(input);
      return;
    }
    if (!isRealtimeControlInput(input)) {
      throw new Error(`Unsupported input type: ${describeInput(input)}`);
    }
    if (input.activityStart) {
      logger.debug('Sending LLM activity start signal.');
      this.geminiSession.sendRealtimeInput({
        activityStart: input.activityStart,
      });
      return;
    }
    if (input.activityEnd) {
      logger.debug('Sending LLM activity end signal.');
      this.geminiSession.sendRealtimeInput({activityEnd: input.activityEnd});
      return;
    }
    if (input.audioStreamEnd) {
      logger.debug('Sending LLM audio stream end signal.');
      this.geminiSession.sendRealtimeInput({audioStreamEnd: true});
      return;
    }
    logger.warn('Unary LiveClientRealtimeInput not fully supported yet.');
  }

  /**
   * Sends an activity start signal to the model.
   */
  async sendActivityStart(): Promise<void> {
    return this.sendRealtime({activityStart: {}});
  }

  /**
   * Sends an activity end signal to the model.
   */
  async sendActivityEnd(): Promise<void> {
    return this.sendRealtime({activityEnd: {}});
  }

  /**
   * Builds a full text response.
   *
   * The text should not be partial and the returned LlmResponse is not be
   * partial.
   *
   * @param text The text to be included in the response.
   * @param isThought Whether the text is a thought.
   * @param groundingMetadata The grounding metadata to include.
   * @returns An LlmResponse containing the full text.
   */
  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    if (!this.messageQueue) {
      throw new Error('Message queue is not initialized.');
    }

    const aggregator = new LiveResponseAggregator(this.modelVersion);

    for await (const message of this.messageQueue) {
      logger.debug('Got LLM Live message:', message);

      for (const response of aggregator.processMessage(message)) {
        yield response;
      }
    }

    for (const response of aggregator.close()) {
      yield response;
    }
  }

  /**
   * Closes the llm server connection.
   */
  async close(): Promise<void> {
    this.geminiSession.close();
  }

  private sendBlob(blob: Blob): void {
    if (
      !isGemini3xLive(this.modelVersion) &&
      !isGemini35LiveTranslate(this.modelVersion)
    ) {
      this.geminiSession.sendRealtimeInput({media: blob});
      return;
    }
    if (blob.mimeType?.startsWith('audio/')) {
      this.geminiSession.sendRealtimeInput({audio: blob});
    } else if (blob.mimeType?.startsWith('image/')) {
      this.geminiSession.sendRealtimeInput({video: blob});
    } else {
      logger.warn(
        'Blob not sent. Unknown or empty mime type for sendRealtimeInput:',
        blob.mimeType,
      );
    }
  }
}
