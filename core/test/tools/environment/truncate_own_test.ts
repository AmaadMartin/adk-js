/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
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

  it('counts an astral character as one, matching adk-python', () => {
    // 'abcd🚀efg' is 9 UTF-16 code units but 8 code points.
    expect(truncate('abcd🚀efg', 8)).toBe('abcd🚀efg');
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
