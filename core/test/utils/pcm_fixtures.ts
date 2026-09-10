/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Little-endian 16-bit PCM helpers shared by the audio tests. */

const BYTES_PER_SAMPLE = 2;

/** Builds little-endian signed 16-bit PCM bytes from integer samples. */
export function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) =>
    view.setInt16(index * BYTES_PER_SAMPLE, sample, true),
  );
  return bytes;
}

/** Decodes little-endian signed 16-bit PCM bytes back into samples. */
export function samplesOf(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoded: number[] = [];
  for (let offset = 0; offset + 1 < bytes.length; offset += BYTES_PER_SAMPLE) {
    decoded.push(view.getInt16(offset, true));
  }
  return decoded;
}

/** The samples `0, 1, ... count - 1`, a ramp that survives resampling. */
export function ramp(count: number): number[] {
  return Array.from({length: count}, (_unused, index) => index);
}
