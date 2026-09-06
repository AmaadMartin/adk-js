/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, GenerateContentConfig, Part} from '@google/genai';
import {z} from 'zod';
import {NotImplementedError} from '../../errors/not_implemented_error.js';
import type {Event} from '../../events/event.js';
import type {BaseLlm} from '../../models/base_llm.js';
import type {LlmRequest} from '../../models/llm_request.js';
import {LLMRegistry} from '../../models/registry.js';
import {LIVE_INPUT_MIME_TYPE, toLiveInput} from '../../utils/audio_utils.js';
import {base64DecodeBytes, base64Encode} from '../../utils/env_aware_utils.js';
import {experimental} from '../../utils/experimental.js';
import {evalModel, type EvalModel} from '../common.js';
import {addDefaultRetryOptionsIfNotPresent} from '../retry_options_utils.js';
import {
  llmUserSimulatorConfigShape,
  UserSimulatorStatus,
  type LlmUserSimulatorConfig,
  type NextUserMessage,
  type UserSimulator,
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
 * renders that text as audio. {@link LlmAudioUserSimulator} reads it.
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

/**
 * Validates an {@link LlmAudioUserSimulatorConfig} payload.
 *
 * A payload that names no `type` gets this one, so a caller can validate a
 * section on its own without repeating the discriminator.
 */
export const llmAudioUserSimulatorConfigModel: EvalModel<LlmAudioUserSimulatorConfig> =
  evalModel(
    {
      type: z
        .literal(LLM_AUDIO_USER_SIMULATOR_TYPE)
        .default(LLM_AUDIO_USER_SIMULATOR_TYPE),
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

const AUTHOR_USER = 'user';

/** The mime type assumed for audio the model did not label. */
const DEFAULT_AUDIO_MIME_TYPE = 'audio/pcm';

/**
 * Builds the audio configuration a simulator uses when its config omits one.
 *
 * A factory and not a shared constant, because
 * {@link addDefaultRetryOptionsIfNotPresent} writes the retry policy into the
 * configuration object it is given. One shared object would carry one
 * simulator's retry policy into every other simulator that took the default.
 */
function defaultAudioModelConfiguration(): GenerateContentConfig {
  return {
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {voiceName: DEFAULT_USER_SIMULATOR_VOICE_NAME},
      },
      languageCode: DEFAULT_USER_SIMULATOR_LANGUAGE_CODE,
    },
  };
}

const NO_AUDIO_DATA_ERROR = 'Audio model returned no audio data';

const AUDIO_GENERATION_FAILED_ERROR = 'Audio generation failed';

const NO_SIMULATION_EVALUATOR_ERROR =
  'LlmAudioUserSimulator has no simulation evaluator.';

function audioGenerationFailed(
  errorCode: string,
  errorMessage: string | undefined,
): string {
  return `${AUDIO_GENERATION_FAILED_ERROR}: ${errorCode} — ${errorMessage ?? ''}`;
}

/**
 * Joins decoded audio chunks.
 *
 * The chunks are joined after decoding, never as base64 text: a chunk whose
 * decoded length is not a multiple of three ends in base64 padding, and
 * joining the encoded strings leaves that padding mid-payload.
 */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/** What one audio model call produced. */
interface GeneratedAudio {
  /** The audio the model returned, decoded. */
  audio: Uint8Array;

  /** The mime type the model labelled the audio with. */
  mimeType: string;
}

/**
 * Speaks the user's turns of an eval case.
 *
 * It decorates a text-producing {@link UserSimulator}: it reads that
 * simulator's turn, renders the text with an audio model, and returns a
 * `Content` carrying the 16 kHz PCM the Live API accepts. The wrapped
 * simulator is a black box — only its `getNextUserMessage` output is read — so
 * it may be any `UserSimulator`, and switching audio backends is a
 * config-only change.
 *
 * A turn the wrapped simulator did not produce successfully, and a successful
 * turn that carries no text, pass through unchanged. The audio model is not
 * called for either.
 *
 * {@link DEFAULT_USER_SIMULATOR_AUDIO_MODEL} needs a Cloud Text-to-Speech
 * model registered with {@link LLMRegistry}, and adk-js registers none yet, so
 * name a Gemini text-to-speech model such as `'gemini-2.5-flash-preview-tts'`
 * or pass `audioLlm`.
 */
@experimental
export class LlmAudioUserSimulator implements UserSimulator {
  private readonly audioModel: string;
  private readonly audioModelConfiguration: GenerateContentConfig;
  private readonly includeTextWithAudio: boolean;
  private readonly textSimulator: UserSimulator;
  private readonly audioLlm: BaseLlm;

  /**
   * @param params.config The settings of the simulator.
   * @param params.textSimulator The simulator that writes the text of a turn.
   * @param params.audioLlm The model that renders the audio. Defaults to the
   *   model `config.audioModel` names, resolved through {@link LLMRegistry}.
   *   Pass one to render audio with a model of your own.
   */
  constructor(params: {
    config: LlmAudioUserSimulatorConfig;
    textSimulator: UserSimulator;
    audioLlm?: BaseLlm;
  }) {
    const {config, textSimulator, audioLlm} = params;
    this.audioModel = config.audioModel ?? DEFAULT_USER_SIMULATOR_AUDIO_MODEL;
    this.audioModelConfiguration =
      config.audioModelConfiguration ?? defaultAudioModelConfiguration();
    this.includeTextWithAudio = config.includeTextWithAudio ?? true;
    this.textSimulator = textSimulator;
    this.audioLlm = audioLlm ?? LLMRegistry.newLlm(this.audioModel);
  }

  /**
   * Returns the next user message, spoken.
   *
   * @param events The conversation so far, unaltered.
   * @returns The next user message, or the wrapped simulator's own result when
   *   that simulator produced no text.
   * @throws {Error} When the audio model reports an error, or returns no
   *   audio.
   */
  async getNextUserMessage(events: Event[]): Promise<NextUserMessage> {
    const textResult = await this.textSimulator.getNextUserMessage(events);
    if (textResult.status !== UserSimulatorStatus.SUCCESS) {
      return textResult;
    }

    const text = (textResult.userMessage?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');
    if (!text) {
      return textResult;
    }

    return {
      status: UserSimulatorStatus.SUCCESS,
      userMessage: await this.toAudioContent(text),
    };
  }

  /**
   * Renders text as a user message carrying audio.
   *
   * The single audio-generation entry point, so a caller holding pre-authored
   * text can speak it without going through the wrapped simulator.
   *
   * @param text The text to speak.
   * @returns A `Content` with the role `user`, carrying a text part followed
   *   by an audio part when `includeTextWithAudio` is set, and the audio part
   *   alone otherwise.
   * @throws {Error} When the audio model reports an error, or returns no
   *   audio.
   */
  async toAudioContent(text: string): Promise<Content> {
    const parts: Part[] = [];
    if (this.includeTextWithAudio) {
      parts.push({text});
    }

    const {audio, mimeType} = await this.generateAudio(text);
    parts.push({
      inlineData: {
        mimeType: LIVE_INPUT_MIME_TYPE,
        data: base64Encode(toLiveInput(audio, mimeType)),
      },
    });

    return {parts, role: AUTHOR_USER};
  }

  /**
   * Always throws: this simulator scores nothing of its own.
   *
   * The return type is `never`, not the interface's `Evaluator | undefined`,
   * because the method has no returning path.
   *
   * @throws {NotImplementedError} Always. adk-python raises
   *   `NotImplementedError` here too.
   */
  getSimulationEvaluator(): never {
    throw new NotImplementedError(NO_SIMULATION_EVALUATOR_ERROR);
  }

  /** Asks the audio model to speak `text`. */
  private async generateAudio(text: string): Promise<GeneratedAudio> {
    const llmRequest: LlmRequest = {
      model: this.audioModel,
      config: this.audioModelConfiguration,
      contents: [{parts: [{text}], role: AUTHOR_USER}],
      liveConnectConfig: {},
      toolsDict: {},
    };
    addDefaultRetryOptionsIfNotPresent(llmRequest);

    const chunks: Uint8Array[] = [];
    let mimeType = DEFAULT_AUDIO_MIME_TYPE;
    for await (const llmResponse of this.audioLlm.generateContentAsync(
      llmRequest,
    )) {
      if (llmResponse.errorCode) {
        throw new Error(
          audioGenerationFailed(
            llmResponse.errorCode,
            llmResponse.errorMessage,
          ),
        );
      }
      for (const part of llmResponse.content?.parts ?? []) {
        if (!part.inlineData?.data) {
          continue;
        }
        chunks.push(base64DecodeBytes(part.inlineData.data));
        if (part.inlineData.mimeType) {
          mimeType = part.inlineData.mimeType;
        }
      }
    }

    const audio = concatBytes(chunks);
    if (audio.length === 0) {
      throw new Error(NO_AUDIO_DATA_ERROR);
    }
    return {audio, mimeType};
  }
}
