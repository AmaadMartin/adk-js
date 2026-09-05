/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';
import {evalModel, type EvalModel} from '../common.js';
import {
  llmUserSimulatorConfigShape,
  type LlmUserSimulatorConfig,
} from './user_simulator.js';

/** The `type` an eval config writes to select the audio simulator. */
export const LLM_AUDIO_USER_SIMULATOR_TYPE = 'llm_audio';

/** The audio model the simulator uses when a config names none. */
export const DEFAULT_USER_SIMULATOR_AUDIO_MODEL = 'cloud_tts';

/** The voice the simulator speaks with when a config names none. */
export const DEFAULT_USER_SIMULATOR_VOICE_NAME = 'en-US-Studio-O';

/** The language the simulator speaks when a config names none. */
export const DEFAULT_USER_SIMULATOR_LANGUAGE_CODE = 'en-US';

/**
 * Configuration for a user simulator that speaks the user's turns.
 *
 * It generates the text of a turn the way the LLM-backed simulator does, then
 * renders that text as audio. This package models the configuration only; the
 * simulator that reads it is not ported yet.
 */
export interface LlmAudioUserSimulatorConfig extends LlmUserSimulatorConfig {
  type: typeof LLM_AUDIO_USER_SIMULATOR_TYPE;

  /**
   * The model that renders the audio. `'cloud_tts'` selects Google Cloud
   * Text-to-Speech; any other value names a model, such as
   * `'gemini-2.5-flash-preview-tts'`. Defaults to
   * {@link DEFAULT_USER_SIMULATOR_AUDIO_MODEL}.
   */
  audioModel?: string;

  /**
   * The configuration for the audio model. Voice selection reads
   * `speechConfig`; native model audio additionally needs
   * `responseModalities: ['AUDIO']`. Defaults to
   * {@link DEFAULT_USER_SIMULATOR_VOICE_NAME} in
   * {@link DEFAULT_USER_SIMULATOR_LANGUAGE_CODE}.
   */
  audioModelConfiguration?: GenerateContentConfig;

  /**
   * Whether a generated turn carries a text part beside its audio part.
   * Defaults to true.
   */
  includeTextWithAudio?: boolean;
}

/** Validates an {@link LlmAudioUserSimulatorConfig} payload. */
export const llmAudioUserSimulatorConfigModel: EvalModel<LlmAudioUserSimulatorConfig> =
  evalModel(
    {
      type: z.literal(LLM_AUDIO_USER_SIMULATOR_TYPE),
      ...llmUserSimulatorConfigShape,
      audioModel: z.string().default(DEFAULT_USER_SIMULATOR_AUDIO_MODEL),
      audioModelConfiguration: z
        .custom<GenerateContentConfig>()
        .default(() => ({
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: DEFAULT_USER_SIMULATOR_VOICE_NAME,
              },
            },
            languageCode: DEFAULT_USER_SIMULATOR_LANGUAGE_CODE,
          },
        })),
      includeTextWithAudio: z.boolean().default(true),
    },
    {name: 'LlmAudioUserSimulatorConfig', extraKeys: 'allow'},
  );
