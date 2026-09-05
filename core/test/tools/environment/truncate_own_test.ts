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

  it('returns text exactly at the limit unchanged', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });

  it('appends a notice giving the original length when it cuts', () => {
    expect(truncate('abcdef', 3)).toBe('abc\n... (truncated, 6 total chars)');
  });

  it('caps to the notice alone at a limit of zero', () => {
    expect(truncate('abc', 0)).toBe('\n... (truncated, 3 total chars)');
  });

  it('drops a leading surrogate the cut would orphan', () => {
    // '😀' is two UTF-16 code units, so a limit of 2 lands between them.
    expect(truncate(`a😀b`, 2)).toBe('a\n... (truncated, 4 total chars)');
  });

  it('keeps a surrogate pair the cut falls after', () => {
    expect(truncate(`a😀b`, 3)).toBe('a😀\n... (truncated, 4 total chars)');
  });

  it('defaults to the shared output cap', () => {
    const oversized = 'x'.repeat(MAX_OUTPUT_CHARS + 1);

    expect(truncate(oversized)).toBe(
      `${'x'.repeat(MAX_OUTPUT_CHARS)}\n... (truncated, ${MAX_OUTPUT_CHARS + 1} total chars)`,
    );
  });
});
