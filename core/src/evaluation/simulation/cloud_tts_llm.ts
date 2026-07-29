/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `BaseLlm` adapter for Google Cloud Text-to-Speech.
 *
 * Wraps the Cloud TTS API behind the standard {@link BaseLlm} interface. Voice
 * selection is read from `LlmRequest.config.speechConfig`; audio is returned as
 * `inlineData` in the {@link LlmResponse}.
 *
 * The heavy `@google-cloud/text-to-speech` SDK is loaded lazily via a dynamic
 * `import()` on the first synthesis call, so importing this module is cheap and
 * the dependency is optional.
 */

import {SpeechConfig} from '@google/genai';

import {BaseLlm} from '../../models/base_llm.js';
import {BaseLlmConnection} from '../../models/base_llm_connection.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {LLMRegistry} from '../../models/registry.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';

/** The npm package that provides the Cloud TTS client. */
const TTS_PACKAGE = '@google-cloud/text-to-speech';

/** The Cloud TTS voice used when a request selects none. */
export const DEFAULT_VOICE_NAME = 'en-US-Studio-O';

/** The BCP-47 language code used when a request selects none. */
export const DEFAULT_LANGUAGE_CODE = 'en-US';

const DEFAULT_AUDIO_ENCODING = 'LINEAR16';

/** Maps Cloud TTS `AudioEncoding` names to the MIME types ADK emits. */
const TTS_ENCODING_TO_MIME_TYPE: Readonly<Record<string, string>> = {
  LINEAR16: 'audio/l16',
  MP3: 'audio/mpeg',
  OGG_OPUS: 'audio/ogg',
  MULAW: 'audio/basic',
  ALAW: 'audio/alaw',
};

/**
 * Extracts and joins the plain text from a request's contents.
 *
 * Ported as a standalone module function (the adk-python `_extract_text`
 * staticmethod uses no instance identity).
 *
 * @param llmRequest The request whose text parts to collect.
 * @returns The joined text (parts separated by a single space).
 * @throws {Error} If the request carries no text parts.
 */
export function extractText(llmRequest: LlmRequest): string {
  const texts: string[] = [];
  for (const content of llmRequest.contents) {
    if (content.parts) {
      for (const part of content.parts) {
        if (part.text) {
          texts.push(part.text);
        }
      }
    }
  }
  if (texts.length === 0) {
    throw new Error('CloudTtsLlm requires text in LlmRequest.contents');
  }
  return texts.join(' ');
}

/** A resolved Cloud TTS voice selection. */
export interface VoiceConfig {
  /** The Cloud TTS voice name (e.g. `en-US-Studio-O`). */
  voiceName: string;
  /** The BCP-47 language code (e.g. `en-US`). */
  languageCode: string;
}

/**
 * Reads the voice selection from `LlmRequest.config.speechConfig`.
 *
 * Ported as a standalone module function (the adk-python `_extract_voice_config`
 * staticmethod uses no instance identity).
 *
 * @param llmRequest The request whose speech config to inspect.
 * @returns The resolved voice name and language code, defaulting to
 *     `en-US-Studio-O` / `en-US` when not specified.
 */
export function extractVoiceConfig(llmRequest: LlmRequest): VoiceConfig {
  let voiceName = DEFAULT_VOICE_NAME;
  let languageCode = DEFAULT_LANGUAGE_CODE;

  // A `speechConfig` string (the shorthand union member) has no `languageCode`
  // or `voiceConfig`, so property access safely yields the defaults.
  const speechConfig = llmRequest.config?.speechConfig as SpeechConfig | string;
  if (typeof speechConfig === 'object') {
    if (speechConfig.languageCode) {
      languageCode = speechConfig.languageCode;
    }
    const configuredVoice =
      speechConfig.voiceConfig?.prebuiltVoiceConfig?.voiceName;
    if (configuredVoice) {
      voiceName = configuredVoice;
    }
  }

  return {voiceName, languageCode};
}

/** The Cloud TTS `synthesizeSpeech` request shape ADK relies on. */
interface SynthesizeSpeechRequest {
  input: {text: string};
  voice: {languageCode: string; name: string};
  audioConfig: {audioEncoding: string; speakingRate: number; pitch: number};
}

/** The Cloud TTS `synthesizeSpeech` response shape ADK relies on. */
interface SynthesizeSpeechResponse {
  /**
   * Mirrors the SDK's `ISynthesizeSpeechResponse.audioContent`, which is
   * `Uint8Array | Buffer | string | null` (`Buffer` is a `Uint8Array`, so the
   * two collapse here). The client's REST fallback mode returns the proto
   * `bytes` field base64-encoded as a string, and a response can omit it.
   */
  audioContent?: Uint8Array | string | null;
}

/** The subset of the Cloud TTS client ADK relies on. */
interface TextToSpeechClientLike {
  synthesizeSpeech(
    request: SynthesizeSpeechRequest,
  ): Promise<[SynthesizeSpeechResponse, ...unknown[]]>;
}

/** The subset of the `@google-cloud/text-to-speech` module ADK relies on. */
interface TextToSpeechModule {
  TextToSpeechClient: new (options?: {
    projectId?: string;
  }) => TextToSpeechClientLike;
}

/**
 * Lazily loads the optional Cloud TTS SDK and constructs a client.
 *
 * @returns A Cloud TTS client.
 * @throws {Error} If the optional `@google-cloud/text-to-speech` package is not
 *     installed.
 */
async function createTtsClient(): Promise<TextToSpeechClientLike> {
  let module: TextToSpeechModule;
  try {
    module = (await import(TTS_PACKAGE)) as unknown as TextToSpeechModule;
  } catch {
    throw new Error(
      `Cloud TTS support requires the optional '${TTS_PACKAGE}' package.` +
        ` Install it with: npm install ${TTS_PACKAGE}`,
    );
  }
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;
  return projectId
    ? new module.TextToSpeechClient({projectId})
    : new module.TextToSpeechClient();
}

/** Parameters accepted by the {@link CloudTtsLlm} constructor. */
export interface CloudTtsLlmParams {
  /** The registry model name; always `cloud_tts`. */
  model: string;
  /**
   * Audio encoding for the TTS output. One of `LINEAR16`, `MP3`, `OGG_OPUS`,
   * `MULAW`, `ALAW`. Defaults to `LINEAR16`.
   */
  audioEncoding?: string;
  /** Speaking speed multiplier (0.25–4.0). Defaults to `1.0` (normal speed). */
  speakingSpeed?: number;
  /** Pitch adjustment in semitones (-20.0 to 20.0). Defaults to `0.0`. */
  pitch?: number;
}

/**
 * A {@link BaseLlm} that delegates to Google Cloud Text-to-Speech.
 *
 * Registered under the `cloud_tts` key so it can be resolved via
 * `LLMRegistry.resolve('cloud_tts')`. Voice selection is read from
 * `GenerateContentConfig.speechConfig`; TTS-specific parameters (encoding,
 * speaking speed, pitch) are exposed as optional constructor fields. The GCP
 * quota project is read from the `GOOGLE_CLOUD_PROJECT` environment variable.
 */
@experimental
export class CloudTtsLlm extends BaseLlm {
  /** Advertises the `cloud_tts` registry key. */
  static override readonly supportedModels: Array<string | RegExp> = [
    'cloud_tts',
  ];

  /** Audio encoding for the TTS output. */
  readonly audioEncoding: string;

  /** Speaking speed multiplier; maps to the Cloud TTS `speakingRate`. */
  readonly speakingSpeed: number;

  /** Pitch adjustment in semitones. */
  readonly pitch: number;

  private ttsClient?: TextToSpeechClientLike;

  /**
   * Creates a `CloudTtsLlm`.
   *
   * @param params The model name plus optional TTS parameters.
   */
  constructor(params: CloudTtsLlmParams) {
    super({model: params.model});
    this.audioEncoding = params.audioEncoding ?? DEFAULT_AUDIO_ENCODING;
    this.speakingSpeed = params.speakingSpeed ?? 1.0;
    this.pitch = params.pitch ?? 0.0;
  }

  /**
   * Synthesizes speech from the request's text via the Cloud TTS API.
   *
   * @param llmRequest Request carrying the text contents and optional
   *     `speechConfig` for voice selection.
   * @param _stream Ignored; TTS always returns a single response.
   * @yields A single {@link LlmResponse} with audio data in `inlineData`, or an
   *     error response (`errorCode='TTS_SYNTHESIS_FAILED'`) if the API call
   *     fails.
   * @throws {Error} If `audioEncoding` is unsupported, the request has no text,
   *     or the optional Cloud TTS package is not installed.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    const mimeType = TTS_ENCODING_TO_MIME_TYPE[this.audioEncoding];
    if (mimeType === undefined) {
      throw new Error(
        `Unsupported audio_encoding: '${this.audioEncoding}'. Supported:` +
          ` ${Object.keys(TTS_ENCODING_TO_MIME_TYPE).join(', ')}`,
      );
    }

    const text = extractText(llmRequest);
    const {voiceName, languageCode} = extractVoiceConfig(llmRequest);

    if (this.ttsClient === undefined) {
      this.ttsClient = await createTtsClient();
    }

    let audioContent: Buffer;
    try {
      const [response] = await this.ttsClient.synthesizeSpeech({
        input: {text},
        voice: {languageCode, name: voiceName},
        audioConfig: {
          audioEncoding: this.audioEncoding,
          speakingRate: this.speakingSpeed,
          pitch: this.pitch,
        },
      });
      if (!response.audioContent) {
        throw new Error('Cloud TTS returned no audio content.');
      }
      // Under REST fallback the proto `bytes` field arrives base64-encoded, so
      // a string must be decoded as base64 rather than UTF-8.
      audioContent =
        typeof response.audioContent === 'string'
          ? Buffer.from(response.audioContent, 'base64')
          : Buffer.from(response.audioContent);
    } catch (e) {
      logger.error(`Cloud TTS synthesis failed: ${e}`);
      yield {errorCode: 'TTS_SYNTHESIS_FAILED', errorMessage: String(e)};
      return;
    }

    logger.debug(
      `Cloud TTS synthesis completed: ${audioContent.length} bytes of` +
        ` ${this.audioEncoding} audio`,
    );

    yield {
      content: {
        role: 'model',
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioContent.toString('base64'),
            },
          },
        ],
      },
    };
  }

  /**
   * Live connections are not supported by the TTS backend.
   *
   * @param _llmRequest Unused.
   * @throws {Error} Always.
   */
  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('CloudTtsLlm does not support live connections.');
  }
}

// Register eagerly so `LLMRegistry.resolve('cloud_tts')` works. This is safe
// because importing this module is cheap -- the heavy Cloud TTS SDK is only
// pulled in via a dynamic import inside `generateContentAsync`.
LLMRegistry.register(CloudTtsLlm);
