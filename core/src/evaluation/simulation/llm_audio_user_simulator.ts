/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LLM-backed audio user simulator.
 *
 * {@link LlmAudioUserSimulator} is a {@link UserSimulator} that generates audio
 * user messages. Text generation is delegated to an inner text
 * `UserSimulator` (used as a black box via composition); the generated text is
 * then fed to a second {@link BaseLlm} (resolved from `audioModel`) to produce
 * audio bytes. The simulator is agnostic to the audio provider -- switching
 * backends is a config-only change.
 */

import {Content, GenerateContentConfig, Part} from '@google/genai';

import {Event} from '../../events/event.js';
import {BaseLlm} from '../../models/base_llm.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LLMRegistry} from '../../models/registry.js';
import {experimental} from '../../utils/experimental.js';
import {addDefaultRetryOptionsIfNotPresent} from '../_retry_options_utils.js';
import {Evaluator} from '../eval_case.js';
// Side-effect import: registers `CloudTtsLlm` under the `cloud_tts` registry key
// so the default `audioModel` resolves without the caller importing it.
import './cloud_tts_llm.js';
import {isValidUserSimulatorTemplate} from './llm_backed_user_simulator_prompts.js';
import {
  BaseUserSimulatorConfig,
  NextUserMessage,
  Status,
  UserSimulator,
} from './user_simulator.js';

const AUTHOR_USER = 'user';
const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash';
const DEFAULT_AUDIO_MODEL = 'cloud_tts';
const DEFAULT_MAX_ALLOWED_INVOCATIONS = 20;
const DEFAULT_AUDIO_MIME_TYPE = 'audio/pcm';

/** Initializer for an {@link LlmAudioUserSimulatorConfig}. */
export interface LlmAudioUserSimulatorConfigInit {
  /** Discriminator; locked to `'llm_audio'`. */
  type?: 'llm_audio';
  /** The model to use for user-simulation text generation. */
  model?: string;
  /** The configuration for the text-generation model. */
  modelConfiguration?: GenerateContentConfig;
  /** Maximum number of invocations allowed (`-1` disables the limit). */
  maxAllowedInvocations?: number;
  /** Custom instruction template (must contain the required placeholders). */
  customInstructions?: string;
  /** Whether to include function calls/responses in the history prompt. */
  includeFunctionCalls?: boolean;
  /** Model name for audio generation (e.g. `cloud_tts` or a Gemini TTS model). */
  audioModel?: string;
  /** The configuration for the audio model (voice selection via `speechConfig`). */
  audioModelConfiguration?: GenerateContentConfig;
  /** Whether to emit a text part alongside the audio part. */
  includeTextWithAudio?: boolean;
}

/**
 * Configuration for an {@link LlmAudioUserSimulator}.
 */
export class LlmAudioUserSimulatorConfig extends BaseUserSimulatorConfig {
  /** Discriminator tag for this config subclass. */
  declare type: 'llm_audio';

  /** The model to use for user-simulation text generation. */
  model: string;

  /** The configuration for the text-generation model. */
  modelConfiguration: GenerateContentConfig;

  /**
   * Maximum number of invocations allowed by the simulated interaction. The
   * initial fixed prompt is counted as an invocation. Set to `-1` to disable
   * the limit (not recommended).
   */
  maxAllowedInvocations: number;

  /**
   * Custom instructions for the simulator. Must contain the Jinja placeholders
   * `{{ stop_signal }}`, `{{ conversation_plan }}`, `{{ conversation_history }}`.
   */
  customInstructions?: string;

  /**
   * Whether to include function calls and responses in the conversation-history
   * prompt provided to the user simulator.
   */
  includeFunctionCalls: boolean;

  /**
   * Model name for audio generation. Use `cloud_tts` for Google Cloud
   * Text-to-Speech (default), or a model name string (e.g.
   * `gemini-2.5-flash-preview-tts`) for a Gemini TTS model.
   */
  audioModel: string;

  /**
   * Configuration for the audio model. Voice selection uses `speechConfig`. For
   * native model audio, additionally set `responseModalities: ['AUDIO']`.
   */
  audioModelConfiguration: GenerateContentConfig;

  /**
   * Whether to include the text part alongside the audio part in the generated
   * `Content`. When `true`, the content has both a text part and an audio
   * `inlineData` part; when `false`, only the audio part is included.
   */
  includeTextWithAudio: boolean;

  /**
   * Creates an `LlmAudioUserSimulatorConfig`.
   *
   * @param data The config fields (or a base config to promote).
   * @throws {Error} If `type` is not `'llm_audio'`, or `customInstructions` is
   *     set but missing the required placeholders.
   */
  constructor(
    data: LlmAudioUserSimulatorConfigInit | BaseUserSimulatorConfig = {},
  ) {
    super(data);
    const input = data as LlmAudioUserSimulatorConfigInit;
    if (input.type !== undefined && input.type !== 'llm_audio') {
      throw new Error("`type` must be 'llm_audio'.");
    }
    if (
      input.customInstructions !== undefined &&
      !isValidUserSimulatorTemplate(input.customInstructions, [
        'stop_signal',
        'conversation_plan',
        'conversation_history',
      ])
    ) {
      throw new Error(
        'custom_instructions must contain each of the following formatting' +
          ' placeholders using Jinja syntax: {{ stop_signal }}, {{' +
          ' conversation_plan }}, {{ conversation_history }}',
      );
    }
    this.type = 'llm_audio';
    this.model = input.model ?? DEFAULT_TEXT_MODEL;
    this.modelConfiguration = input.modelConfiguration ?? {
      thinkingConfig: {includeThoughts: true, thinkingBudget: 10240},
    };
    this.maxAllowedInvocations =
      input.maxAllowedInvocations ?? DEFAULT_MAX_ALLOWED_INVOCATIONS;
    this.customInstructions = input.customInstructions;
    this.includeFunctionCalls = input.includeFunctionCalls ?? false;
    this.audioModel = input.audioModel ?? DEFAULT_AUDIO_MODEL;
    this.audioModelConfiguration = input.audioModelConfiguration ?? {
      speechConfig: {
        voiceConfig: {prebuiltVoiceConfig: {voiceName: 'en-US-Studio-O'}},
        languageCode: 'en-US',
      },
    };
    this.includeTextWithAudio = input.includeTextWithAudio ?? true;
  }
}

/** Aggregated audio produced by the audio model. */
interface GeneratedAudio {
  /** The concatenated raw audio bytes. */
  audioBytes: Buffer;
  /** The MIME type reported by the audio model. */
  mimeType: string;
}

/**
 * A {@link UserSimulator} that generates *audio* user messages.
 *
 * Acts as a decorator over a text-producing `UserSimulator` (the
 * `textSimulator`): it consumes that simulator's `getNextUserMessage` output
 * (text) and feeds the text to a second {@link BaseLlm} (resolved from
 * `audioModel`) to produce audio bytes. The wrapped simulator is treated as a
 * black box, so it may be any `UserSimulator` -- e.g. an
 * `LlmBackedUserSimulator` (scenario-driven) or a `StaticUserSimulator`
 * (pre-authored turns).
 *
 * Non-SUCCESS results (e.g. `STOP_SIGNAL_DETECTED`, `TURN_LIMIT_REACHED`) and
 * SUCCESS results carrying no text are passed through unchanged.
 */
@experimental
export class LlmAudioUserSimulator extends UserSimulator {
  /** The resolved configuration for this simulator. */
  readonly config: LlmAudioUserSimulatorConfig;

  private readonly textSimulator: UserSimulator;
  private readonly audioLlm: BaseLlm;

  /**
   * Creates an `LlmAudioUserSimulator` as a decorator over a text simulator.
   *
   * The supplied `config` is promoted to a concrete
   * {@link LlmAudioUserSimulatorConfig}, and `textSimulator` is the wrapped
   * simulator whose text turns are converted to audio.
   */
  constructor({
    config,
    textSimulator,
  }: {
    config: BaseUserSimulatorConfig;
    textSimulator: UserSimulator;
  }) {
    super();
    this.config = new LlmAudioUserSimulatorConfig(config);
    this.textSimulator = textSimulator;
    this.audioLlm = LLMRegistry.newLlm(this.config.audioModel);
  }

  /**
   * Returns the next user message (with audio) to send to the agent.
   *
   * Delegates text generation to the wrapped `textSimulator`, then converts the
   * text to audio. Non-SUCCESS results and SUCCESS results with no text are
   * passed through unchanged.
   *
   * @param events The unaltered conversation history.
   * @returns The next user message containing audio, or a passthrough status.
   * @throws {Error} If audio generation fails.
   */
  override async getNextUserMessage(events: Event[]): Promise<NextUserMessage> {
    const textResult = await this.textSimulator.getNextUserMessage(events);

    if (textResult.status !== Status.SUCCESS) {
      return textResult;
    }

    // A SUCCESS result always carries a `userMessage` (NextUserMessage
    // enforces this invariant), so it is safe to read here.
    let text = '';
    for (const part of textResult.userMessage!.parts ?? []) {
      if (part.text) {
        text += part.text;
      }
    }

    if (!text) {
      return textResult;
    }

    return new NextUserMessage({
      status: Status.SUCCESS,
      userMessage: await this.toAudioContent(text),
    });
  }

  /**
   * Converts `text` into a user `Content` carrying audio.
   *
   * This is the single, reusable audio-generation entry point.
   *
   * @param text The text to convert to audio.
   * @returns A `Content` with role `user`. When `includeTextWithAudio` is
   *     `true` the content has a text part followed by an audio `inlineData`
   *     part; otherwise it has only the audio part.
   * @throws {Error} If audio generation fails.
   */
  async toAudioContent(text: string): Promise<Content> {
    const parts: Part[] = [];

    if (this.config.includeTextWithAudio) {
      parts.push({text});
    }

    const {audioBytes, mimeType} = await this.generateAudio(text);
    parts.push({
      inlineData: {mimeType, data: audioBytes.toString('base64')},
    });

    return {parts, role: AUTHOR_USER};
  }

  private async generateAudio(text: string): Promise<GeneratedAudio> {
    const llmRequest: LlmRequest = {
      model: this.config.audioModel,
      config: this.config.audioModelConfiguration,
      contents: [{parts: [{text}], role: AUTHOR_USER}],
      liveConnectConfig: {},
      toolsDict: {},
    };
    addDefaultRetryOptionsIfNotPresent(llmRequest);

    const chunks: Buffer[] = [];
    let mimeType = DEFAULT_AUDIO_MIME_TYPE;
    for await (const llmResponse of this.audioLlm.generateContentAsync(
      llmRequest,
    )) {
      if (llmResponse.errorCode) {
        throw new Error(
          `Audio generation failed: ${llmResponse.errorCode} —` +
            ` ${llmResponse.errorMessage}`,
        );
      }

      const parts = llmResponse.content?.parts;
      if (parts) {
        for (const part of parts) {
          const inlineData = part.inlineData;
          if (inlineData?.data) {
            chunks.push(Buffer.from(inlineData.data, 'base64'));
            if (inlineData.mimeType) {
              mimeType = inlineData.mimeType;
            }
          }
        }
      }
    }

    if (chunks.length === 0) {
      throw new Error('Audio model returned no audio data');
    }

    return {audioBytes: Buffer.concat(chunks), mimeType};
  }

  /**
   * Returns the simulation evaluator.
   *
   * @throws {Error} Always -- the concrete evaluator is a separate port.
   */
  override getSimulationEvaluator(): Evaluator | undefined {
    throw new Error('Not implemented.');
  }
}
