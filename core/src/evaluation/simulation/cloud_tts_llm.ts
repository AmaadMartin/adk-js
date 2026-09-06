/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `BaseLlm` adapter for Google Cloud Text-to-Speech.
 *
 * Ported from adk-python
 * `src/google/adk/evaluation/simulation/_cloud_tts_llm.py`.
 */

import type {protos} from '@google-cloud/text-to-speech';
import {createPartFromBase64} from '@google/genai';

import {BaseLlm} from '../../models/base_llm.js';
import {BaseLlmConnection} from '../../models/base_llm_connection.js';
import {LlmRequest} from '../../models/llm_request.js';
import {LlmResponse} from '../../models/llm_response.js';
import {LLMRegistry} from '../../models/registry.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer, OptionalPeer} from '../../utils/optional_peer.js';

type ISynthesizeSpeechRequest =
  protos.google.cloud.texttospeech.v1.ISynthesizeSpeechRequest;
type ISynthesizeSpeechResponse =
  protos.google.cloud.texttospeech.v1.ISynthesizeSpeechResponse;
type IAudioConfig = protos.google.cloud.texttospeech.v1.IAudioConfig;

/** The registry key this model answers to. */
export const CLOUD_TTS_MODEL_NAME = 'cloud_tts';

/** The Cloud TTS voice used when a request selects none. */
export const DEFAULT_TTS_VOICE_NAME = 'en-US-Studio-O';

/** The BCP-47 language code used when a request selects none. */
export const DEFAULT_TTS_LANGUAGE_CODE = 'en-US';

/** The audio encoding used when a caller selects none. */
export const DEFAULT_TTS_AUDIO_ENCODING = 'LINEAR16';

/** The Cloud TTS audio encodings this model can label with a MIME type. */
type SupportedAudioEncoding =
  | 'LINEAR16'
  | 'MP3'
  | 'OGG_OPUS'
  | 'MULAW'
  | 'ALAW';

/** Maps a Cloud TTS `AudioEncoding` name to the MIME type ADK emits. */
const TTS_ENCODING_TO_MIME_TYPE: Readonly<
  Record<SupportedAudioEncoding, string>
> = {
  LINEAR16: 'audio/l16',
  MP3: 'audio/mpeg',
  OGG_OPUS: 'audio/ogg',
  MULAW: 'audio/basic',
  ALAW: 'audio/alaw',
};

/** The optional peer backing {@link CloudTtsLlm}. */
const CLOUD_TTS_PEER: OptionalPeer = {
  packageName: '@google-cloud/text-to-speech',
  feature: 'CloudTtsLlm (Google Cloud Text-to-Speech)',
};

/** Error codes {@link CloudTtsLlm} reports on an {@link LlmResponse}. */
export enum CloudTtsErrorCode {
  /** The Cloud TTS API rejected or failed the synthesis request. */
  SYNTHESIS_FAILED = 'TTS_SYNTHESIS_FAILED',
}

/** A resolved Cloud TTS voice selection. */
export interface CloudTtsVoiceSelection {
  /** The Cloud TTS voice name, e.g. `en-US-Studio-O`. */
  voiceName: string;
  /** The BCP-47 language code, e.g. `en-US`. */
  languageCode: string;
}

/**
 * The subset of the Cloud TTS client ADK calls.
 *
 * Declaring the surface rather than naming `TextToSpeechClient` lets a caller
 * inject a pre-configured or fake client, and avoids an `instanceof` check
 * against a class that arrives through a dynamic import.
 */
export interface CloudTtsClient {
  synthesizeSpeech(
    request: ISynthesizeSpeechRequest,
  ): Promise<[ISynthesizeSpeechResponse, ...unknown[]]>;
}

/** Constructor parameters for {@link CloudTtsLlm}. */
export interface CloudTtsLlmParams {
  /** The registry model name. Defaults to `cloud_tts`. */
  model?: string;
  /**
   * Audio encoding for the output: `LINEAR16`, `MP3`, `OGG_OPUS`, `MULAW` or
   * `ALAW`. Defaults to `LINEAR16`. Validated on the first synthesis call.
   */
  audioEncoding?: string;
  /**
   * Speaking speed multiplier (0.25-4.0). Defaults to `1.0`. `null` omits
   * `speakingRate` from the request, leaving the API default in force.
   */
  speakingSpeed?: number | null;
  /**
   * Pitch adjustment in semitones (-20.0 to 20.0). Defaults to `0.0`. `null`
   * omits `pitch` from the request.
   */
  pitch?: number | null;
  /** A pre-configured client. Skips the SDK's credential resolution. */
  client?: CloudTtsClient;
}

/**
 * Joins the text parts of a request into one string.
 *
 * @param llmRequest The request whose text parts to collect.
 * @return The text parts, joined with a single space.
 * @throws {Error} `CloudTtsLlm requires text in LlmRequest.contents` when the
 *   request carries no text part.
 */
export function extractText(llmRequest: LlmRequest): string {
  const texts: string[] = [];
  for (const content of llmRequest.contents) {
    for (const part of content.parts ?? []) {
      if (part.text) {
        texts.push(part.text);
      }
    }
  }
  if (texts.length === 0) {
    throw new Error('CloudTtsLlm requires text in LlmRequest.contents');
  }
  return texts.join(' ');
}

/**
 * Reads the voice selection from `LlmRequest.config.speechConfig`, falling
 * back to {@link DEFAULT_TTS_VOICE_NAME} / {@link DEFAULT_TTS_LANGUAGE_CODE}.
 *
 * `speechConfig` is `SpeechConfig | string` in `@google/genai`; the string
 * shorthand carries no language code, so it yields the defaults.
 *
 * @param llmRequest The request to read the speech configuration from.
 * @return The voice name and language code to synthesize with.
 */
export function extractVoiceConfig(
  llmRequest: LlmRequest,
): CloudTtsVoiceSelection {
  const speechConfig = llmRequest.config?.speechConfig;
  if (typeof speechConfig !== 'object') {
    return {
      voiceName: DEFAULT_TTS_VOICE_NAME,
      languageCode: DEFAULT_TTS_LANGUAGE_CODE,
    };
  }
  return {
    voiceName:
      speechConfig.voiceConfig?.prebuiltVoiceConfig?.voiceName ??
      DEFAULT_TTS_VOICE_NAME,
    languageCode: speechConfig.languageCode ?? DEFAULT_TTS_LANGUAGE_CODE,
  };
}

/** Narrows an encoding name to one this model can label with a MIME type. */
function isSupportedAudioEncoding(
  encoding: string,
): encoding is SupportedAudioEncoding {
  return Object.hasOwn(TTS_ENCODING_TO_MIME_TYPE, encoding);
}

/**
 * Recognises a google-gax `GoogleError`, which carries the numeric gRPC
 * status as `code`. Matched structurally rather than with `instanceof`,
 * because the class arrives through a dynamic import and two copies of
 * google-gax in one runtime would make the check silently false. Node's own
 * `ERR_MODULE_NOT_FOUND` carries a string `code`, so it is not matched here.
 */
function isGoogleApiCallError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    typeof (err as Error & {code?: unknown}).code === 'number'
  );
}

/**
 * Loads the `@google-cloud/text-to-speech` optional peer and builds a client
 * from Application Default Credentials.
 *
 * `GOOGLE_CLOUD_PROJECT`, when set, selects the project, matching what the
 * other Google Cloud clients in ADK do with it. Credentials are resolved by
 * the SDK on the first call, not here. Cloud Text-to-Speech also needs a quota
 * project under user credentials; google-auth-library reads that only from
 * `GOOGLE_CLOUD_QUOTA_PROJECT` or from the credentials file, so no client
 * option can set it here.
 *
 * @return A client for {@link CloudTtsLlm} to synthesize through.
 * @throws {Error} If `@google-cloud/text-to-speech` is not installed.
 */
export async function createCloudTtsClient(): Promise<CloudTtsClient> {
  const {TextToSpeechClient} = await loadOptionalPeer(
    CLOUD_TTS_PEER,
    () => import('@google-cloud/text-to-speech'),
  );
  const projectId = process.env['GOOGLE_CLOUD_PROJECT'];
  return projectId
    ? new TextToSpeechClient({projectId})
    : new TextToSpeechClient();
}

/** Builds the Cloud TTS `audioConfig`, omitting the fields set to `null`. */
function buildAudioConfig(
  audioEncoding: SupportedAudioEncoding,
  speakingSpeed: number | null,
  pitch: number | null,
): IAudioConfig {
  const audioConfig: IAudioConfig = {audioEncoding};
  if (speakingSpeed !== null) {
    audioConfig.speakingRate = speakingSpeed;
  }
  if (pitch !== null) {
    audioConfig.pitch = pitch;
  }
  return audioConfig;
}

/**
 * A {@link BaseLlm} that renders the text of a request as speech through the
 * Google Cloud Text-to-Speech API.
 *
 * Voice selection is read from `LlmRequest.config.speechConfig`; the audio
 * comes back as an `inlineData` part on a single {@link LlmResponse}. The
 * model registers itself under the `cloud_tts` key, which is how an evaluation
 * config reaches it.
 *
 * `@google-cloud/text-to-speech` is an optional peer dependency, loaded on the
 * first synthesis call, so importing this module does not pull in the SDK.
 */
@experimental
export class CloudTtsLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    CLOUD_TTS_MODEL_NAME,
  ];

  /** The Cloud TTS `AudioEncoding` name the output is encoded with. */
  readonly audioEncoding: string;

  /** The speaking speed multiplier, or `null` to use the API default. */
  readonly speakingSpeed: number | null;

  /** The pitch adjustment in semitones, or `null` to use the API default. */
  readonly pitch: number | null;

  private readonly injectedClient?: CloudTtsClient;
  private clientPromise?: Promise<CloudTtsClient>;

  constructor(params: CloudTtsLlmParams = {}) {
    super({model: params.model ?? CLOUD_TTS_MODEL_NAME});
    this.audioEncoding = params.audioEncoding ?? DEFAULT_TTS_AUDIO_ENCODING;
    // Only `undefined` takes the default: an explicit `null` omits the field.
    this.speakingSpeed =
      params.speakingSpeed === undefined ? 1.0 : params.speakingSpeed;
    this.pitch = params.pitch === undefined ? 0.0 : params.pitch;
    this.injectedClient = params.client;
  }

  /**
   * Synthesizes the text of a request into speech.
   *
   * @param llmRequest The request carrying the text to speak and, optionally,
   *   a `config.speechConfig` selecting the voice.
   * @param _stream Ignored. Cloud TTS always returns one response.
   * @param _abortSignal Ignored. The SDK call is not cancellable here.
   * @return One {@link LlmResponse}: an `inlineData` audio part on success, or
   *   an error response carrying
   *   {@link CloudTtsErrorCode.SYNTHESIS_FAILED} when the API call fails.
   * @throws {Error} If `audioEncoding` is unsupported, if the request carries
   *   no text, if the optional peer is not installed, or if Cloud TTS returns
   *   a successful response with no audio.
   */
  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    if (!isSupportedAudioEncoding(this.audioEncoding)) {
      throw new Error(
        `Unsupported audioEncoding: '${this.audioEncoding}'. Supported: ` +
          `${Object.keys(TTS_ENCODING_TO_MIME_TYPE).join(', ')}`,
      );
    }
    const encoding = this.audioEncoding;
    const text = extractText(llmRequest);
    const {voiceName, languageCode} = extractVoiceConfig(llmRequest);
    const client = await this.getClient();

    let response: ISynthesizeSpeechResponse;
    try {
      [response] = await client.synthesizeSpeech({
        input: {text},
        voice: {languageCode, name: voiceName},
        audioConfig: buildAudioConfig(encoding, this.speakingSpeed, this.pitch),
      });
    } catch (err: unknown) {
      if (!isGoogleApiCallError(err)) {
        throw err;
      }
      logger.error(`Cloud TTS synthesis failed: ${err.message}`);
      yield {
        errorCode: CloudTtsErrorCode.SYNTHESIS_FAILED,
        errorMessage: err.message,
      };
      return;
    }

    const {audioContent} = response;
    if (!audioContent) {
      throw new Error('Cloud TTS returned no audio content.');
    }
    // The REST fallback returns the proto `bytes` field base64-encoded, so a
    // string must be decoded as base64 rather than as UTF-8.
    const audio =
      typeof audioContent === 'string'
        ? Buffer.from(audioContent, 'base64')
        : Buffer.from(audioContent);
    logger.debug(
      `Cloud TTS synthesis completed: ${audio.length} bytes of ${encoding} audio`,
    );

    yield {
      content: {
        role: 'model',
        parts: [
          createPartFromBase64(
            audio.toString('base64'),
            TTS_ENCODING_TO_MIME_TYPE[encoding],
          ),
        ],
      },
    };
  }

  /** Cloud TTS is request/response only; there is no live connection. */
  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(
      new Error(`Live connection is not supported for ${this.model}.`),
    );
  }

  /**
   * Resolves the Cloud TTS client, loading the optional peer on first use.
   * The promise is memoised so concurrent first calls share one client.
   */
  private getClient(): Promise<CloudTtsClient> {
    this.clientPromise ??= this.injectedClient
      ? Promise.resolve(this.injectedClient)
      : createCloudTtsClient();
    return this.clientPromise;
  }
}

LLMRegistry.register(CloudTtsLlm);
