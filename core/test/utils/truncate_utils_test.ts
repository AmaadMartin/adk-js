/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  truncateMiddle,
} from '../../src/utils/truncate_utils.js';

describe('truncate_utils', () => {
  describe('truncateMiddle', () => {
    it('returns the input unchanged when it is shorter than the limit', () => {
      expect(truncateMiddle('abcde', 10)).toBe('abcde');
    });

    it('returns the input unchanged when its length equals the limit', () => {
      expect(truncateMiddle('abcde', 5)).toBe('abcde');
    });

    it('truncates when the input is one character over the limit', () => {
      expect(truncateMiddle('abcdef', 5)).toBe(
        'abc\n... [truncated 1 characters] ...\nef',
      );
    });

    it('keeps half the limit from each end for an even limit', () => {
      const text = 'x'.repeat(50) + 'y'.repeat(50);

      const result = truncateMiddle(text, 20);

      expect(result.startsWith('x'.repeat(10))).toBe(true);
      expect(result.endsWith('y'.repeat(10))).toBe(true);
      expect(result).toBe(
        `${'x'.repeat(10)}\n... [truncated 80 characters] ...\n${'y'.repeat(10)}`,
      );
    });

    it('rounds the head up and the tail down for an odd limit', () => {
      const text = 'abcdefghij'.repeat(10);

      const result = truncateMiddle(text, 7);

      expect(result).toBe(`abcd\n... [truncated 93 characters] ...\nhij`);
    });

    it('reports the number of removed characters, not the total', () => {
      expect(truncateMiddle('0123456789', 4)).toBe(
        '01\n... [truncated 6 characters] ...\n89',
      );
    });

    it('returns marker-only output for a zero limit', () => {
      expect(truncateMiddle('abcdef', 0)).toBe(
        '\n... [truncated 6 characters] ...\n',
      );
    });

    it('clamps a negative limit to zero', () => {
      expect(truncateMiddle('abcdef', -100)).toBe(
        '\n... [truncated 6 characters] ...\n',
      );
    });

    it('defaults to DEFAULT_MAX_OUTPUT_CHARS characters', () => {
      expect(DEFAULT_MAX_OUTPUT_CHARS).toBe(30_000);

      const atLimit = 'a'.repeat(DEFAULT_MAX_OUTPUT_CHARS);
      expect(truncateMiddle(atLimit)).toBe(atLimit);

      const overLimit = 'a'.repeat(DEFAULT_MAX_OUTPUT_CHARS + 1);
      const result = truncateMiddle(overLimit);
      expect(result).toContain('... [truncated 1 characters] ...');
      expect(result.length).toBe(
        DEFAULT_MAX_OUTPUT_CHARS +
          '\n... [truncated 1 characters] ...\n'.length,
      );
    });
  });
});
