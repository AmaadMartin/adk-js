/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/evaluation/test_audio_utils.py` from
 * google/adk-python at commit a119dd77. Each ported `it` keeps the name of the
 * Python test it ports; the `adk-js specific` group covers behaviour the
 * reference suite does not.
 */

import {
  LIVE_INPUT_MIME_TYPE,
  LIVE_INPUT_RATE_HZ,
  parseSampleRate,
  resamplePcm16,
  toLiveInput,
} from '@google/adk';
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
import {pcm, ramp, samplesOf} from './pcm_fixtures.js';

describe('audio_utils', () => {
  describe('parseSampleRate', () => {
    it('test_parse_sample_rate_extracts_rate_parameter', () => {
      expect(parseSampleRate('audio/l16; rate=24000', 8000)).toBe(24000);
    });

    it('test_parse_sample_rate_without_rate_returns_default', () => {
      expect(parseSampleRate('audio/pcm', 16000)).toBe(16000);
    });

    it('test_parse_sample_rate_none_returns_default', () => {
      expect(parseSampleRate(undefined, 16000)).toBe(16000);
    });

    it('test_parse_sample_rate_ignores_rate_substrings', () => {
      expect(parseSampleRate('audio/pcm;bitrate=128000', 24000)).toBe(24000);
    });

    it('test_parse_sample_rate_is_case_insensitive', () => {
      expect(parseSampleRate('audio/pcm;RATE=16000', 24000)).toBe(16000);
    });
  });

  describe('resamplePcm16', () => {
    it('test_resample_matching_rates_returns_input_unchanged', () => {
      const input = pcm([1, 2, 3, 4]);

      expect(resamplePcm16(input, 16000, 16000)).toEqual(input);
    });

    it('test_resample_empty_input_returns_empty', () => {
      expect(resamplePcm16(new Uint8Array(0), 24000, 16000)).toEqual(
        new Uint8Array(0),
      );
    });

    it('test_resample_zero_source_rate_raises', () => {
      expect(() => resamplePcm16(pcm([1, 2]), 0, 16000)).toThrow(
        'Sample rates must be positive',
      );
    });

    it('test_resample_zero_target_rate_raises', () => {
      expect(() => resamplePcm16(pcm([1, 2]), 24000, 0)).toThrow(
        'Sample rates must be positive',
      );
    });

    it('test_resample_single_sample_returns_input_unchanged', () => {
      const input = pcm([42]);

      expect(resamplePcm16(input, 24000, 16000)).toEqual(input);
    });

    it('test_resample_downsamples_by_rate_ratio', () => {
      const input = pcm(ramp(600));

      expect(samplesOf(resamplePcm16(input, 24000, 16000))).toHaveLength(400);
    });

    it('test_resample_interpolates_between_samples', () => {
      // Source samples 0..3 at 24 kHz; target index 1 maps to position 1.5,
      // halfway between samples[1]=100 and samples[2]=200, so 150.
      const input = pcm([0, 100, 200, 300]);

      const result = samplesOf(resamplePcm16(input, 24000, 16000));

      expect(result[1]).toBe(150);
    });
  });

  describe('toLiveInput', () => {
    let warn: MockInstance<(...args: unknown[]) => void>;

    beforeEach(() => {
      warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('test_to_live_input_resamples_from_declared_rate', () => {
      const result = toLiveInput(pcm(ramp(600)), 'audio/l16; rate=24000');

      expect(samplesOf(result)).toHaveLength(400);
    });

    it('test_to_live_input_defaults_to_common_tts_rate_and_warns', () => {
      const result = toLiveInput(pcm(ramp(600)), 'audio/pcm');

      // The 24 kHz default downsamples 600 samples to 400 at 16 kHz...
      expect(samplesOf(result)).toHaveLength(400);
      // ...and the missing rate warns rather than guessing in silence.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no `rate=`'));
    });

    it('test_to_live_input_does_not_warn_when_rate_is_declared', () => {
      toLiveInput(pcm(ramp(600)), 'audio/l16; rate=24000');

      expect(warn).not.toHaveBeenCalled();
    });

    it('test_to_live_input_at_target_rate_is_unchanged', () => {
      const input = pcm([1, 2, 3, 4]);

      expect(toLiveInput(input, LIVE_INPUT_MIME_TYPE)).toEqual(input);
    });
  });

  describe('adk-js specific', () => {
    describe('toLiveInput', () => {
      let warn: MockInstance<(...args: unknown[]) => void>;

      beforeEach(() => {
        warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('warns and assumes the output rate when the mime type is absent', () => {
        const result = toLiveInput(pcm(ramp(600)), undefined);

        expect(samplesOf(result)).toHaveLength(400);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('no `rate=`'),
        );
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
        // Python's int() truncates toward zero, and real PCM has negative
        // samples. These rates put output index 1 at position 1.875, so the
        // interpolated value is exactly -200.625: Math.trunc gives -200, while
        // Math.floor and Math.round both give -201.
        const input = pcm([0, -100, -215, -300]);

        const result = samplesOf(
          resamplePcm16(input, 30000, LIVE_INPUT_RATE_HZ),
        );

        expect(result[1]).toBe(-200);
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

        const result = samplesOf(
          resamplePcm16(input, 24000, LIVE_INPUT_RATE_HZ),
        );

        expect(result[1]).toBe(150);
      });
    });
  });
});
