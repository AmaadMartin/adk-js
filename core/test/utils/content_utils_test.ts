/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Language, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  coerceToUserContent,
  contentHasNonTextParts,
  contentToText,
  filterAudioParts,
  isAudioPart,
  isContent,
  toUserContent,
} from '../../src/utils/content_utils.js';

describe('isAudioPart', () => {
  it('should return true for inline audio data', () => {
    expect(
      isAudioPart({inlineData: {mimeType: 'audio/pcm', data: 'abc'}}),
    ).toBe(true);
  });

  it('should return true for audio file data', () => {
    expect(
      isAudioPart({fileData: {mimeType: 'audio/pcm', fileUri: 'gs://a.pcm'}}),
    ).toBe(true);
  });

  it('should return false for inline image data', () => {
    expect(
      isAudioPart({inlineData: {mimeType: 'image/png', data: 'abc'}}),
    ).toBe(false);
  });

  it('should return false for a text part', () => {
    expect(isAudioPart({text: 'hello'})).toBe(false);
  });

  it('should return false for a blob with no mime type', () => {
    expect(isAudioPart({inlineData: {data: 'abc'}})).toBe(false);
    expect(isAudioPart({fileData: {fileUri: 'gs://a.pcm'}})).toBe(false);
  });
});

describe('filterAudioParts', () => {
  it('should return undefined for a content with no parts', () => {
    expect(filterAudioParts({role: 'user'})).toBeUndefined();
    expect(filterAudioParts({role: 'user', parts: []})).toBeUndefined();
  });

  it('should return undefined when every part is audio', () => {
    const content: Content = {
      role: 'user',
      parts: [
        {inlineData: {mimeType: 'audio/pcm', data: 'abc'}},
        {fileData: {mimeType: 'audio/wav', fileUri: 'gs://a.wav'}},
      ],
    };

    expect(filterAudioParts(content)).toBeUndefined();
  });

  it('should keep the non-audio parts and preserve the role', () => {
    const content: Content = {
      role: 'user',
      parts: [
        {inlineData: {mimeType: 'audio/pcm', data: 'abc'}},
        {text: 'hello'},
        {inlineData: {mimeType: 'image/png', data: 'img'}},
      ],
    };

    expect(filterAudioParts(content)).toEqual({
      role: 'user',
      parts: [
        {text: 'hello'},
        {inlineData: {mimeType: 'image/png', data: 'img'}},
      ],
    });
  });

  it('should not mutate the input content', () => {
    const parts = [
      {inlineData: {mimeType: 'audio/pcm', data: 'abc'}},
      {text: 'hello'},
    ];
    const content: Content = {role: 'user', parts};

    filterAudioParts(content);

    expect(content.parts).toBe(parts);
    expect(content.parts).toHaveLength(2);
  });
});

describe('isContent', () => {
  it('is true for objects with a parts array', () => {
    expect(isContent({parts: []})).toBe(true);
    expect(isContent({role: 'model', parts: [{text: 'x'}]})).toBe(true);
  });

  it('is false without a parts array', () => {
    expect(isContent({role: 'model'})).toBe(false);
    expect(isContent({parts: 'x'})).toBe(false);
    expect(isContent('x')).toBe(false);
    expect(isContent(null)).toBe(false);
  });
});

describe('toUserContent', () => {
  it('returns the same object for a Content', () => {
    const content: Content = {role: 'model', parts: [{text: 'hi'}]};
    expect(toUserContent(content)).toBe(content);
  });

  it('wraps a string as user content', () => {
    expect(toUserContent('hello')).toEqual({
      role: 'user',
      parts: [{text: 'hello'}],
    });
  });

  it('wraps a single part', () => {
    const part: Part = {text: 'part'};
    expect(toUserContent(part)).toEqual({role: 'user', parts: [part]});
  });

  it('wraps a part list preserving order', () => {
    const parts: Part[] = [{text: 'a'}, {text: 'b'}];
    expect(toUserContent(parts)).toEqual({role: 'user', parts});
  });
});

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

describe('coerceToUserContent', () => {
  it('wraps a string in one user-role text part', () => {
    expect(coerceToUserContent('fix the flake')).toEqual({
      role: 'user',
      parts: [{text: 'fix the flake'}],
    });
  });

  it('keeps the parts of a Content and re-roles it to user', () => {
    const given: Content = {role: 'model', parts: [{text: 'hello'}]};

    expect(coerceToUserContent(given)).toEqual({
      role: 'user',
      parts: [{text: 'hello'}],
    });
  });

  it('serializes any other value to JSON so a text model can read it', () => {
    expect(coerceToUserContent({bug: 42})).toEqual({
      role: 'user',
      parts: [{text: '{"bug":42}'}],
    });
  });

  it('JSON-encodes anything else into one text part', () => {
    expect(coerceToUserContent({task: 'primes', limit: 10})).toEqual({
      role: 'user',
      parts: [{text: '{"task":"primes","limit":10}'}],
    });
  });

  it('encodes a number rather than dropping it', () => {
    expect(coerceToUserContent(42)).toEqual({
      role: 'user',
      parts: [{text: '42'}],
    });
  });
});
