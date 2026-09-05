/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Language} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  contentHasNonTextParts,
  contentToText,
} from '../../src/utils/content_utils.js';

describe('contentToText', () => {
  it('returns an empty string when there are no parts', () => {
    expect(contentToText({role: 'user'})).toBe('');
    expect(contentToText({role: 'user', parts: []})).toBe('');
  });

  it('joins text parts with no separator', () => {
    expect(
      contentToText({role: 'user', parts: [{text: 'Hello'}, {text: ' world'}]}),
    ).toBe('Hello world');
  });

  it('keeps an empty text part', () => {
    expect(
      contentToText({role: 'user', parts: [{text: ''}, {text: 'a'}]}),
    ).toBe('a');
  });

  it('skips a part that carries no text', () => {
    expect(
      contentToText({
        role: 'user',
        parts: [
          {text: 'keep'},
          {inlineData: {data: 'AAAA', mimeType: 'image/png'}},
          {thought: true},
        ],
      }),
    ).toBe('keep');
  });
});

describe('contentHasNonTextParts', () => {
  it('is false when there are no parts', () => {
    expect(contentHasNonTextParts({role: 'user'})).toBe(false);
    expect(contentHasNonTextParts({role: 'user', parts: []})).toBe(false);
  });

  it('is false for text-only parts', () => {
    expect(
      contentHasNonTextParts({role: 'user', parts: [{text: 'a'}, {text: 'b'}]}),
    ).toBe(false);
  });

  it('is false for a part that carries neither text nor data', () => {
    expect(
      contentHasNonTextParts({role: 'user', parts: [{thought: true}]}),
    ).toBe(false);
  });

  it('is true for inline data', () => {
    expect(
      contentHasNonTextParts({
        role: 'user',
        parts: [{inlineData: {data: 'AAAA', mimeType: 'image/png'}}],
      }),
    ).toBe(true);
  });

  it('is true for file data', () => {
    expect(
      contentHasNonTextParts({
        role: 'user',
        parts: [
          {fileData: {fileUri: 'gs://bucket/a.png', mimeType: 'image/png'}},
        ],
      }),
    ).toBe(true);
  });

  it('is true for executable code', () => {
    expect(
      contentHasNonTextParts({
        role: 'user',
        parts: [
          {executableCode: {code: 'print(1)', language: Language.PYTHON}},
        ],
      }),
    ).toBe(true);
  });
});
