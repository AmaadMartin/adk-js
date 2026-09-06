/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MemoryEntry} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {extractText} from '../../src/memory/memory_entry_utils.js';

function memoryWithParts(parts?: Part[]): MemoryEntry {
  return {content: {role: 'user', parts}};
}

const INLINE_DATA_PART: Part = {
  inlineData: {mimeType: 'image/png', data: 'AAAA'},
};

describe('extractText', () => {
  it('returns an empty string when parts is undefined', () => {
    expect(extractText(memoryWithParts(undefined))).toBe('');
  });

  it('returns an empty string when parts is empty', () => {
    expect(extractText(memoryWithParts([]))).toBe('');
  });

  it('joins text parts with a single space', () => {
    expect(extractText(memoryWithParts([{text: 'a'}, {text: 'b'}]))).toBe(
      'a b',
    );
  });

  it('emits no separator for a text-free part between text parts', () => {
    expect(
      extractText(
        memoryWithParts([{text: 'a'}, INLINE_DATA_PART, {text: 'b'}]),
      ),
    ).toBe('a b');
  });

  it('returns an empty string for a single text-free part', () => {
    expect(extractText(memoryWithParts([INLINE_DATA_PART]))).toBe('');
  });

  it('returns an empty string, not a separator, when every part is text-free', () => {
    const parts: Part[] = [
      INLINE_DATA_PART,
      {functionCall: {name: 'lookup', args: {}}},
    ];

    expect(extractText(memoryWithParts(parts))).toBe('');
  });

  it('drops a part whose text is the empty string', () => {
    expect(extractText(memoryWithParts([{text: ''}, {text: 'b'}]))).toBe('b');
  });
});
