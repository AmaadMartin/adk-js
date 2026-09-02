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
import {isGemini3xFlashLive} from '../utils/model_name.js';

import {BaseLlmConnection} from './base_llm_connection.js';
import {LlmResponse} from './llm_response.js';

/** The Gemini model connection. */
export class GeminiLlmConnection implements BaseLlmConnection {
  /**
   * @param geminiSession The live session this connection drives.
   * @param modelVersion The model the session was opened against.
   * @param messageQueue The queue the session's messages arrive on.
   * @param onCloseRequested Called by {@link close} before the session is torn
   *     down, so the owner can tell a teardown it asked for from a drop.
   */
  constructor(
    private readonly geminiSession: Session,
    private readonly modelVersion?: string,
    private readonly messageQueue?: AsyncIterable<LiveServerMessage>,
    private readonly onCloseRequested?: () => void,
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
   * Sends a chunk of audio or a frame of video to the model in realtime.
   *
   * @param blob The blob to send to the model.
   */
  async sendRealtime(blob: Blob): Promise<void> {
    logger.debug('Sending LLM Blob:', blob);
    const isGemini3x = isGemini3xFlashLive(this.modelVersion);
    const isNativeAudio = this.modelVersion?.includes('native-audio');

    if (isGemini3x || isNativeAudio) {
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
    } else {
      this.geminiSession.sendRealtimeInput({media: blob});
    }
  }

  /**
   * Sends an activity start signal to the model.
   */
  async sendActivityStart(): Promise<void> {
    this.geminiSession.sendRealtimeInput({activityStart: {}});
  }

  /**
   * Sends an activity end signal to the model.
   */
  async sendActivityEnd(): Promise<void> {
    this.geminiSession.sendRealtimeInput({activityEnd: {}});
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

    // A dropped connection still has to flush what the aggregator already
    // parsed, or the caller loses a pending tool call.
    let failure: {error: unknown} | undefined;
    try {
      for await (const message of this.messageQueue) {
        logger.debug('Got LLM Live message:', message);

        for (const response of aggregator.processMessage(message)) {
          yield response;
        }
      }
    } catch (error: unknown) {
      failure = {error};
    }

    for (const response of aggregator.close()) {
      yield response;
    }

    if (failure) {
      throw failure.error;
    }
  }

  /**
   * Closes the llm server connection.
   */
  async close(): Promise<void> {
    this.onCloseRequested?.();
    this.geminiSession.close();
  }
}
