/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {MAX_OUTPUT_CHARS} from '../../../src/tools/environment/constants.js';
import {truncate} from '../../../src/tools/environment/truncate.js';

describe('truncate', () => {
  it('returns text shorter than the limit unchanged', () => {
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('leaves text shorter than the limit untouched', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('returns text that is exactly at the limit unchanged', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });

  it('leaves text exactly at the limit untouched', () => {
    expect(truncate('a'.repeat(10), 10)).toBe('a'.repeat(10));
  });

  it('adds the notice when the text is one character over', () => {
    expect(truncate('abcdef', 5)).toBe('abcde\n... (truncated, 6 total chars)');
  });

  it('truncates one character over the limit and reports the original length', () => {
    expect(truncate('a'.repeat(11), 10)).toBe(
      `${'a'.repeat(10)}\n... (truncated, 11 total chars)`,
    );
  });

  it('adds the notice when the cut is well inside the text', () => {
    expect(truncate('abcdef', 3)).toBe('abc\n... (truncated, 6 total chars)');
  });

  it('defaults to the 30000-character cap', () => {
    const text = 'a'.repeat(MAX_OUTPUT_CHARS + 1);
    expect(truncate(text)).toBe(
      'a'.repeat(MAX_OUTPUT_CHARS) +
        `\n... (truncated, ${MAX_OUTPUT_CHARS + 1} total chars)`,
    );
  });

  it('counts an astral character as one, matching adk-python', () => {
    // 'abcd🚀efg' is 9 UTF-16 code units but 8 code points.
    expect(truncate('abcd🚀efg', 8)).toBe('abcd🚀efg');
  });

  it('does not split a surrogate pair at the cut', () => {
    // '😀' is one code point, so a cut at 3 keeps it whole.
    expect(truncate('ab😀cd', 3)).toBe('ab😀\n... (truncated, 5 total chars)');
  });

  it('keeps a surrogate pair that sits before the cut', () => {
    expect(truncate('ab😀cd', 4)).toBe('ab😀c\n... (truncated, 5 total chars)');
  });

  it('keeps a whole surrogate pair when the cut lands just after it', () => {
    expect(truncate('abcd🚀efg', 5)).toBe(
      'abcd🚀\n... (truncated, 8 total chars)',
    );
  });

  it('never splits a surrogate pair when the cut lands just before it', () => {
    expect(truncate('abcd🚀efg', 4)).toBe(
      'abcd\n... (truncated, 8 total chars)',
    );
  });

  it('truncates everything when the limit is zero', () => {
    expect(truncate('abc', 0)).toBe('\n... (truncated, 3 total chars)');
  });
});
