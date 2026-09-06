/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Audio helpers for feeding synthesized speech into a Live API session.
 *
 * Text-to-speech backends commonly emit 24 kHz PCM, but the Live API accepts
 * 16 kHz PCM input only, so simulated user audio is resampled before it is
 * sent.
 */

import {InputValidationError} from '../errors/input_validation_error.js';

import {logger} from './logger.js';

/** The sample rate, in hertz, of the audio the Live API accepts as input. */
export const LIVE_INPUT_RATE_HZ = 16000;

/** The sample rate, in hertz, of the audio the Live API emits as output. */
export const LIVE_OUTPUT_RATE_HZ = 24000;

/** The mime type of the audio the Live API accepts as input. */
export const LIVE_INPUT_MIME_TYPE = 'audio/pcm;rate=16000';

const BYTES_PER_SAMPLE = 2;

/**
 * Matches the `rate` parameter of a mime type.
 *
 * The leading `(?:^|;)` is what keeps a parameter that merely ends in `rate`,
 * such as `bitrate`, from reading as the sample rate.
 */
const RATE_PATTERN = /(?:^|;)\s*rate\s*=\s*(\d+)\s*(?=;|$)/i;

const NON_POSITIVE_RATE_ERROR = 'Sample rates must be positive';

function matchSampleRate(mimeType: string | undefined): RegExpExecArray | null {
  return mimeType ? RATE_PATTERN.exec(mimeType) : null;
}

/**
 * Reads the sample rate out of a mime type such as `audio/pcm;rate=24000`.
 *
 * @param mimeType The mime type to read.
 * @param defaultRate The rate to return when the mime type declares none.
 * @returns The declared rate, or `defaultRate`.
 */
export function parseSampleRate(
  mimeType: string | undefined,
  defaultRate: number,
): number {
  const match = matchSampleRate(mimeType);
  return match ? Number(match[1]) : defaultRate;
}

/**
 * Resamples 16-bit mono PCM by linear interpolation.
 *
 * Audio whose rates already match, and audio too short to interpolate, comes
 * back unchanged. That keeps speech relayed to a transcribing model off a
 * heavy signal-processing dependency.
 *
 * @param pcm The little-endian 16-bit mono samples to resample.
 * @param srcRate The sample rate of `pcm`, in hertz.
 * @param dstRate The sample rate to produce, in hertz.
 * @returns The resampled audio.
 * @throws {InputValidationError} When either rate is zero or negative.
 */
export function resamplePcm16(
  pcm: Uint8Array,
  srcRate: number,
  dstRate: number,
): Uint8Array {
  if (srcRate <= 0 || dstRate <= 0) {
    throw new InputValidationError(NON_POSITIVE_RATE_ERROR);
  }
  if (pcm.length === 0 || srcRate === dstRate) {
    return pcm;
  }

  // A trailing odd byte is not a whole sample, so it is left out of the
  // sample count and the input is returned as it is when too little remains.
  const sampleCount = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (sampleCount < 2) {
    return pcm;
  }

  const source = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const ratio = srcRate / dstRate;
  const outputCount = Math.max(1, Math.trunc(sampleCount / ratio));
  const output = new Uint8Array(outputCount * BYTES_PER_SAMPLE);
  const outputView = new DataView(output.buffer);
  const lastIndex = sampleCount - 1;

  for (let i = 0; i < outputCount; i++) {
    const position = i * ratio;
    const left = Math.trunc(position);
    const right = Math.min(left + 1, lastIndex);
    const fraction = position - left;
    const interpolated =
      source.getInt16(left * BYTES_PER_SAMPLE, true) * (1 - fraction) +
      source.getInt16(right * BYTES_PER_SAMPLE, true) * fraction;
    outputView.setInt16(i * BYTES_PER_SAMPLE, Math.trunc(interpolated), true);
  }
  return output;
}

/**
 * Resamples synthesized speech to the 16 kHz PCM the Live API accepts.
 *
 * @param pcm The little-endian 16-bit mono samples to resample.
 * @param sourceMimeType The mime type the audio arrived with.
 * @returns The audio at {@link LIVE_INPUT_RATE_HZ}.
 */
export function toLiveInput(
  pcm: Uint8Array,
  sourceMimeType: string | undefined,
): Uint8Array {
  // Warn rather than guess in silence: a wrong assumed rate mis-pitches the
  // audio, and nothing downstream can tell that it happened.
  if (!matchSampleRate(sourceMimeType)) {
    logger.warn(
      `Audio mime type '${sourceMimeType ?? ''}' has no \`rate=\`; assuming` +
        ` ${LIVE_OUTPUT_RATE_HZ} Hz before resampling to the Live API input` +
        ' rate. Mislabeled audio will be resampled incorrectly.',
    );
  }
  return resamplePcm16(
    pcm,
    parseSampleRate(sourceMimeType, LIVE_OUTPUT_RATE_HZ),
    LIVE_INPUT_RATE_HZ,
  );
}
