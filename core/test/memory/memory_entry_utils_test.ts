/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MemoryEntry} from '@google/adk';
import {describe, expect, it} from 'vitest';

// extractText is internal and deliberately not exported from '@google/adk'.
import {extractText} from '../../src/memory/memory_entry_utils.js';

describe('extractText', () => {
  it('joins two text parts with a single space by default', () => {
    const memory: MemoryEntry = {
      content: {role: 'user', parts: [{text: 'hello'}, {text: 'world'}]},
    };

    expect(extractText(memory)).toBe('hello world');
  });

  it('skips a text-free part between two text parts', () => {
    const memory: MemoryEntry = {
      content: {
        role: 'user',
        parts: [{text: 'hello'}, {functionCall: {name: 'f'}}, {text: 'world'}],
      },
    };

    expect(extractText(memory)).toBe('hello world');
  });

  it('returns an empty string when no part has text', () => {
    const memory: MemoryEntry = {
      content: {
        role: 'user',
        parts: [
          {functionCall: {name: 'f'}},
          {inlineData: {mimeType: 'audio/wav', data: 'AAAA'}},
        ],
      },
    };

    expect(extractText(memory)).toBe('');
    expect(extractText(memory)).toBeFalsy();
  });

  it('returns an empty string when parts is undefined', () => {
    const memory: MemoryEntry = {content: {role: 'user'}};

    expect(extractText(memory)).toBe('');
  });

  it('returns an empty string when parts is empty', () => {
    const memory: MemoryEntry = {content: {role: 'user', parts: []}};

    expect(extractText(memory)).toBe('');
  });

  it('drops an empty-string text part', () => {
    const memory: MemoryEntry = {
      content: {role: 'user', parts: [{text: ''}, {text: 'a'}]},
    };

    expect(extractText(memory)).toBe('a');
  });

  it('returns a single text part verbatim', () => {
    const memory: MemoryEntry = {
      content: {role: 'user', parts: [{text: 'hello'}]},
    };

    expect(extractText(memory)).toBe('hello');
  });
});
