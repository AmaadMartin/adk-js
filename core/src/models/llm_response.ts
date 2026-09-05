/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CitationMetadata,
  Content,
  FinishReason,
  GenerateContentResponse,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  LiveServerGoAway,
  LiveServerSessionResumptionUpdate,
  Transcription,
  TurnCompleteReason,
  VoiceActivity,
} from '@google/genai';

/**
 * The activity state of a live session, reported alongside `turnComplete`.
 *
 * This mirrors the `InteractionStatus` enum of `@google/genai`, which the
 * pinned version of that package does not export yet. The string values are
 * the same, so the two are wire-compatible.
 *
 * NOTE: this is unrelated to the Interactions API `InteractionStatusUpdate`.
 */
export enum InteractionStatus {
  /** The model reported no activity state. */
  INTERACTION_STATUS_UNSPECIFIED = 'INTERACTION_STATUS_UNSPECIFIED',
  /** The model still works on the prompt, and more model turns follow. */
  IN_PROGRESS = 'IN_PROGRESS',
  /** @deprecated Use {@link InteractionStatus.IDLE} instead. */
  REQUIRES_ACTION = 'REQUIRES_ACTION',
  /** The model finished the prompt and waits for more user input. */
  IDLE = 'IDLE',
}

/**
 * LLM response class that provides the first candidate response from the
 * model if available. Otherwise, returns error code and message.
 */
export interface LlmResponse {
  /**
   * The content of the response.
   */
  content?: Content;

  /**
   * The grounding metadata of the response.
   */
  groundingMetadata?: GroundingMetadata;

  /**
   * The citation metadata of the response.
   */
  citationMetadata?: CitationMetadata;

  /**
   * Indicates whether the text content is part of a unfinished text stream.
   * Only used for streaming mode and when the content is plain text.
   */
  partial?: boolean;

  /**
   * Indicates whether the response from the model is complete.
   * Only used for streaming mode.
   */
  turnComplete?: boolean;

  /**
   * The reason why the turn is complete.
   * Only used for streaming mode.
   */
  turnCompleteReason?: TurnCompleteReason;

  /**
   * The activity state of the live session, reported with `turnComplete`.
   *
   * Newer live models may answer one user prompt with several model turns, so
   * `turnComplete` alone no longer means the model is done. This field
   * separates the two cases:
   *
   * * `IN_PROGRESS`: the model still works on the user's prompt, and more
   *   turns follow. The app must not treat the interaction as finished, and
   *   must not re-enable the microphone yet.
   * * `IDLE`: the model finished the user's prompt and waits for more user
   *   input.
   *
   * It stays absent for models that do not report it. A caller that builds a
   * turn-taking user interface should then treat `turnComplete === true` as
   * terminal.
   */
  interactionStatus?: InteractionStatus;

  /**
   * Error code if the response is an error. Code varies by model.
   */
  errorCode?: string;

  /**
   * Error message if the response is an error.
   */
  errorMessage?: string;

  /**
   * Flag indicating that LLM was interrupted when generating the content.
   * Usually it's due to user interruption during a bidi streaming.
   */
  interrupted?: boolean;

  /**
   * The custom metadata of the LlmResponse.
   * An optional key-value pair to label an LlmResponse.
   * NOTE: the entire object must be JSON serializable.
   */
  customMetadata?: {[key: string]: unknown};

  /**
   * The usage metadata of the LlmResponse.
   */
  usageMetadata?: GenerateContentResponseUsageMetadata;

  /**
   * The finish reason of the response.
   */
  finishReason?: FinishReason;

  /**
   * The session resumption update of the LlmResponse
   */
  liveSessionResumptionUpdate?: LiveServerSessionResumptionUpdate;

  /**
   * Server-side signal that the live connection will be closed soon. The
   * caller should reconnect using the latest session resumption handle.
   */
  goAway?: LiveServerGoAway;

  /**
   * Voice activity signal from the Live model.
   */
  voiceActivity?: VoiceActivity;

  /**
   * Audio transcription of user input.
   */
  inputTranscription?: Transcription;

  /**
   * Audio transcription of model output.
   */
  outputTranscription?: Transcription;

  /**
   * The interaction ID returned by the model, if any.
   */
  interactionId?: string;

  /** The model version used to generate the response. */
  modelVersion?: string;

  /** The session ID of the Live session. */
  liveSessionId?: string;
}

/**
 * Creates an LlmResponse from a GenerateContentResponse.
 *
 * @param response The GenerateContentResponse to create the
 *   LlmResponse from.
 * @returns The LlmResponse.
 */
export function createLlmResponse(
  response: GenerateContentResponse,
): LlmResponse {
  const usageMetadata = response.usageMetadata;

  if (response.candidates && response.candidates.length > 0) {
    const candidate = response.candidates[0];
    if (candidate.content?.parts && candidate.content.parts.length > 0) {
      return {
        content: candidate.content,
        groundingMetadata: candidate.groundingMetadata,
        citationMetadata: candidate.citationMetadata,
        usageMetadata: usageMetadata,
        finishReason: candidate.finishReason,
      };
    }

    return {
      errorCode: candidate.finishReason,
      errorMessage: candidate.finishMessage,
      usageMetadata: usageMetadata,
      citationMetadata: candidate.citationMetadata,
      finishReason: candidate.finishReason,
    };
  }

  if (response.promptFeedback) {
    return {
      errorCode: response.promptFeedback.blockReason,
      errorMessage: response.promptFeedback.blockReasonMessage,
      usageMetadata: usageMetadata,
    };
  }

  // The ultimate fallback for an unknown error state
  return {
    errorCode: 'UNKNOWN_ERROR',
    errorMessage: 'Unknown error.',
    usageMetadata: usageMetadata,
  };
}
