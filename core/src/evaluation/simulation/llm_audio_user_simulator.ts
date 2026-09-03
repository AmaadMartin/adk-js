/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';
import {EvalModel, evalModel} from '../common.js';
import {
  LlmUserSimulatorFields,
  llmUserSimulatorFieldsShape,
} from './llm_backed_user_simulator.js';
import {BaseUserSimulatorConfig} from './user_simulator.js';

/** The `type` of an {@link LlmAudioUserSimulatorConfig}. */
export const LLM_AUDIO_USER_SIMULATOR_TYPE = 'llm_audio';

/** Speaks the user's messages with Google Cloud Text-to-Speech. */
const CLOUD_TTS_AUDIO_MODEL = 'cloud_tts';

/** The voice of {@link defaultAudioModelConfiguration}. */
const DEFAULT_VOICE_NAME = 'en-US-Studio-O';

/** The language of {@link defaultAudioModelConfiguration}. */
const DEFAULT_LANGUAGE_CODE = 'en-US';

/** Builds the audio configuration a simulator uses when its config omits it. */
function defaultAudioModelConfiguration(): GenerateContentConfig {
  return {
    speechConfig: {
      voiceConfig: {prebuiltVoiceConfig: {voiceName: DEFAULT_VOICE_NAME}},
      languageCode: DEFAULT_LANGUAGE_CODE,
    },
  };
}

/**
 * The settings of a user simulator that speaks the messages a model writes.
 *
 * It wraps a text simulator: the text fields configure the model that writes
 * a message, and the audio fields configure the model that speaks it.
 */
export interface LlmAudioUserSimulatorConfig
  extends BaseUserSimulatorConfig, LlmUserSimulatorFields {
  type: typeof LLM_AUDIO_USER_SIMULATOR_TYPE;

  /**
   * The model that speaks the user's messages. Use `'cloud_tts'` for Google
   * Cloud Text-to-Speech, or the name of a Gemini text-to-speech model such
   * as `'gemini-2.5-flash-preview-tts'`.
   */
  audioModel: string;

  /**
   * The configuration of
   * {@link LlmAudioUserSimulatorConfig.audioModel}. `speechConfig` selects
   * the voice. A model that generates audio natively also needs
   * `responseModalities: ['AUDIO']`.
   */
  audioModelConfiguration: GenerateContentConfig;

  /**
   * Whether the generated message carries the text alongside the audio. When
   * false, the message carries the audio alone.
   */
  includeTextWithAudio: boolean;
}

/** Validates an {@link LlmAudioUserSimulatorConfig} payload. */
const llmAudioUserSimulatorConfigModel: EvalModel<LlmAudioUserSimulatorConfig> =
  evalModel(
    {
      type: z
        .literal(LLM_AUDIO_USER_SIMULATOR_TYPE)
        .default(LLM_AUDIO_USER_SIMULATOR_TYPE),
      ...llmUserSimulatorFieldsShape,
      audioModel: z.string().default(CLOUD_TTS_AUDIO_MODEL),
      audioModelConfiguration: z
        .custom<GenerateContentConfig>()
        .default(defaultAudioModelConfiguration),
      includeTextWithAudio: z.boolean().default(true),
    },
    {name: 'LlmAudioUserSimulatorConfig', extraKeys: 'allow'},
  );

/**
 * Validates an audio user simulator payload and applies every default.
 *
 * A key the config does not name is kept, so a simulator can read a setting
 * of its own out of a validated config.
 *
 * @throws {InputValidationError} When the payload names another `type`, or
 *   gives a field a value of the wrong kind.
 */
export function parseLlmAudioUserSimulatorConfig(
  raw: unknown,
): LlmAudioUserSimulatorConfig {
  return llmAudioUserSimulatorConfigModel.parse(raw);
}
