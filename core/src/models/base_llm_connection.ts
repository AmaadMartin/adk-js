/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob, Content, LiveClientRealtimeInput} from '@google/genai';

import {LlmResponse} from './llm_response.js';

/**
 * Input accepted by {@link BaseLlmConnection.sendRealtime}.
 *
 * A `Blob` is a chunk of audio or a frame of video. A
 * `LiveClientRealtimeInput` carries a control signal instead: the start of
 * user activity, the end of user activity, or the end of the audio stream.
 */
export type RealtimeInput = Blob | LiveClientRealtimeInput;

/**
 * The base class for a live model connection.
 */
export interface BaseLlmConnection {
  /**
   * Sends the conversation history to the model.
   *
   * You call this method right after setting up the model connection.
   * The model will respond if the last content is from user, otherwise it will
   * wait for new user input before responding.
   *
   * @param history The conversation history to send to the model.
   */
  sendHistory(history: Content[]): Promise<void>;

  /**
   * Sends the content to the model.
   *
   * The model will respond immediately upon receiving the content.
   * If you send function responses, all parts in the content should be function
   * responses.
   *
   * @param content The content to send to the model.
   */
  sendContent(content: Content): Promise<void>;

  /**
   * Sends a chunk of audio, a frame of video, or a realtime control signal to
   * the model.
   *
   * The model may not respond immediately upon receiving a blob. It will do
   * voice activity detection and decide when to respond.
   *
   * @param input The blob or control signal to send to the model.
   */
  sendRealtime(input: RealtimeInput): Promise<void>;

  /**
   * Optionally signals the start of user activity (e.g. user begins speaking)
   * for models that support manual activity boundaries.
   */
  sendActivityStart?(): Promise<void>;

  /**
   * Optionally signals the end of user activity (e.g. user finishes speaking)
   * for models that support manual activity boundaries.
   */
  sendActivityEnd?(): Promise<void>;

  /**
   * Receives the model response using the llm server connection.
   *
   * @return A generator of LlmResponse.
   */
  receive(): AsyncGenerator<LlmResponse, void, void>;

  /**
   * Closes the llm server connection.
   */
  close(): Promise<void>;
}
