/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for audio helper behaviour the ported adk-python suite does not cover.
 */

import {LIVE_INPUT_RATE_HZ, resamplePcm16, toLiveInput} from '@google/adk';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {logger} from '../../src/utils/logger.js';

/** Builds little-endian signed 16-bit PCM bytes from integer samples. */
function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

function samplesOf(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoded: number[] = [];
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    decoded.push(view.getInt16(offset, true));
  }
  return decoded;
}

describe('audio_utils (adk-js specific)', () => {
  describe('toLiveInput', () => {
    let warn: MockInstance<(...args: unknown[]) => void>;

    beforeEach(() => {
      warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('warns and assumes the output rate when the mime type is absent', () => {
      const result = toLiveInput(
        pcm(Array.from({length: 600}, (_unused, i) => i)),
        undefined,
      );

      expect(samplesOf(result)).toHaveLength(400);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no `rate=`'));
    });
  });

  describe('resamplePcm16', () => {
    it('returns a trailing odd byte unchanged with the rest', () => {
      // Python keeps the odd byte: it drops it only from the sample view and
      // then returns the original buffer.
      const input = new Uint8Array([0x57, 0x41, 0x56]);

      expect(resamplePcm16(input, 24000, LIVE_INPUT_RATE_HZ)).toEqual(input);
    });

    it('truncates toward zero on negative samples', () => {
      // Python's int() truncates toward zero. Math.round and Math.floor both
      // disagree with it here: the exact value is -149.5.
      const input = pcm([0, -100, -200, -300]);

      const result = samplesOf(resamplePcm16(input, 24000, LIVE_INPUT_RATE_HZ));

      expect(result[1]).toBe(-150);
    });

    it('upsamples when the target rate is higher', () => {
      const input = pcm([0, 100, 200, 300]);

      const result = samplesOf(resamplePcm16(input, 16000, 24000));

      expect(result).toHaveLength(6);
    });

    it('reads a buffer that starts at an odd byte offset', () => {
      // A Uint8Array view at an odd offset cannot be read through
      // `new Int16Array(view.buffer)`; DataView can.
      const backing = new Uint8Array(9);
      backing.set(pcm([0, 100, 200, 300]), 1);
      const input = backing.subarray(1);

      const result = samplesOf(resamplePcm16(input, 24000, LIVE_INPUT_RATE_HZ));

      expect(result[1]).toBe(150);
    });
  });
});
