/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {MAX_OUTPUT_CHARS} from '../../../src/tools/environment/constants.js';
import {truncate} from '../../../src/tools/environment/truncate.js';

describe('truncate', () => {
  it('returns text that is exactly at the limit unchanged', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });

  it('adds the notice when the text is one character over', () => {
    expect(truncate('abcdef', 5)).toBe('abcde\n... (truncated, 6 total chars)');
  });

  it('defaults to the 30000-character cap', () => {
    const text = 'a'.repeat(MAX_OUTPUT_CHARS + 1);
    expect(truncate(text)).toBe(
      'a'.repeat(MAX_OUTPUT_CHARS) +
        `\n... (truncated, ${MAX_OUTPUT_CHARS + 1} total chars)`,
    );
  });

  it('does not split a surrogate pair at the cut', () => {
    // '😀' is two UTF-16 code units, so a cut at 3 would land inside it.
    const text = 'ab😀cd';
    expect(truncate(text, 3)).toBe('ab\n... (truncated, 6 total chars)');
  });

  it('keeps a surrogate pair that ends exactly at the cut', () => {
    const text = 'ab😀cd';
    expect(truncate(text, 4)).toBe('ab😀\n... (truncated, 6 total chars)');
  });

  it('truncates everything when the limit is zero', () => {
    expect(truncate('abc', 0)).toBe('\n... (truncated, 3 total chars)');
  });
});
