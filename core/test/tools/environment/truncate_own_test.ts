/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {MAX_OUTPUT_CHARS} from '../../../src/tools/environment/constants.js';
import {truncate} from '../../../src/tools/environment/truncate.js';

describe('truncate', () => {
  it('leaves text shorter than the limit untouched', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('leaves text exactly at the limit untouched', () => {
    expect(truncate('a'.repeat(10), 10)).toBe('a'.repeat(10));
  });

  it('truncates one character over the limit and reports the original length', () => {
    expect(truncate('a'.repeat(11), 10)).toBe(
      `${'a'.repeat(10)}\n... (truncated, 11 total chars)`,
    );
  });

  it('caps at MAX_OUTPUT_CHARS when no limit is given', () => {
    const text = 'a'.repeat(MAX_OUTPUT_CHARS + 1);

    expect(truncate(text)).toBe(
      `${'a'.repeat(MAX_OUTPUT_CHARS)}\n... (truncated, ${MAX_OUTPUT_CHARS + 1} total chars)`,
    );
  });

  it('drops a surrogate pair straddling the cut rather than splitting it', () => {
    // The rocket is one astral character, so it occupies code units 4 and 5.
    const text = `abcd🚀efg`;

    const result = truncate(text, 5);

    expect(result).toBe('abcd\n... (truncated, 9 total chars)');
  });

  it('keeps a surrogate pair that ends exactly on the cut', () => {
    const text = `abcd🚀efg`;

    const result = truncate(text, 6);

    expect(result).toBe('abcd🚀\n... (truncated, 9 total chars)');
  });

  it('counts UTF-16 code units, so an astral character counts as two', () => {
    expect(truncate('🚀', 2)).toBe('🚀');
    expect(truncate('🚀', 1)).toBe('\n... (truncated, 2 total chars)');
  });

  it('truncates everything when the limit is zero', () => {
    expect(truncate('abc', 0)).toBe('\n... (truncated, 3 total chars)');
  });
});
