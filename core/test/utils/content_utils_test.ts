/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  contentUnionToText,
  contentUnionToUserContent,
  extractTextFromContent,
  filterAudioParts,
  isAudioPart,
  isContent,
  SKIP_THOUGHT_SIGNATURE_VALIDATOR,
  toUserContent,
} from '../../src/utils/content_utils.js';

describe('contentUnionToText', () => {
  it('returns undefined for undefined', () => {
    expect(contentUnionToText(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(contentUnionToText('')).toBeUndefined();
  });

  it('returns a non-empty string unchanged', () => {
    expect(contentUnionToText('A')).toBe('A');
  });

  it('returns the text of a bare Part', () => {
    const part: Part = {text: 'A'};
    expect(contentUnionToText(part)).toBe('A');
  });

  it('returns undefined for a Part with an empty text', () => {
    const part: Part = {text: ''};
    expect(contentUnionToText(part)).toBeUndefined();
  });

  it('returns undefined for a Part that carries no text', () => {
    const part: Part = {inlineData: {mimeType: 'image/png', data: 'AAAA'}};
    expect(contentUnionToText(part)).toBeUndefined();
  });

  it('joins the parts of a Content with a newline', () => {
    const content: Content = {
      role: 'system',
      parts: [{text: 'A'}, {text: 'B'}],
    };
    expect(contentUnionToText(content)).toBe('A\nB');
  });

  it('returns undefined for a Content whose parts carry no text', () => {
    const content: Content = {role: 'system', parts: [{}]};
    expect(contentUnionToText(content)).toBeUndefined();
  });

  it('returns undefined for a Content with an empty parts array', () => {
    const content: Content = {role: 'system', parts: []};
    expect(contentUnionToText(content)).toBeUndefined();
  });

  it('returns undefined for a Content whose parts key is undefined', () => {
    const content: Content = {role: 'system', parts: undefined};
    expect(contentUnionToText(content)).toBeUndefined();
  });

  it('returns undefined for an empty array', () => {
    expect(contentUnionToText([])).toBeUndefined();
  });

  it('joins a string array with a newline', () => {
    expect(contentUnionToText(['A', 'B'])).toBe('A\nB');
  });

  it('joins a Part array with a newline', () => {
    const parts: Part[] = [{text: 'A'}, {text: 'B'}];
    expect(contentUnionToText(parts)).toBe('A\nB');
  });

  it('skips the empty and text-less members of a mixed array', () => {
    const value: Array<string | Part> = ['A', {text: 'B'}, {}, ''];
    expect(contentUnionToText(value)).toBe('A\nB');
  });

  it('does not mutate its argument', () => {
    const content: Content = {
      role: 'system',
      parts: [{text: 'A'}, {}, {text: 'B'}],
    };
    const pristine = structuredClone(content);

    contentUnionToText(content);

    expect(content).toEqual(pristine);
  });
});

function audioBlobPart(mimeType?: string): Part {
  return {inlineData: {mimeType, data: 'AAE='}};
}

function audioFilePart(mimeType?: string): Part {
  return {fileData: {fileUri: 'files/clip', mimeType}};
}

describe('SKIP_THOUGHT_SIGNATURE_VALIDATOR', () => {
  it('decodes to the byte string the backend recognizes', () => {
    // The backend matches these exact bytes to bypass validation; changing
    // them would break every replayed synthetic part.
    expect(
      Buffer.from(SKIP_THOUGHT_SIGNATURE_VALIDATOR, 'base64').toString('utf8'),
    ).toBe('skip_thought_signature_validator');
  });

  it('survives a round trip through a Part', () => {
    const part: Part = {
      text: 'injected',
      thoughtSignature: SKIP_THOUGHT_SIGNATURE_VALIDATOR,
    };
    expect(part.thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE_VALIDATOR);
  });
});

describe('isContent', () => {
  it('accepts a value with a parts array', () => {
    expect(isContent({parts: []})).toBe(true);
    expect(isContent({role: 'user', parts: [{text: 'hi'}]})).toBe(true);
  });

  it('rejects a value without a parts array', () => {
    expect(isContent({role: 'user'})).toBe(false);
    expect(isContent({parts: 'x'})).toBe(false);
    expect(isContent('hi')).toBe(false);
    expect(isContent(null)).toBe(false);
  });
});

describe('toUserContent', () => {
  it('turns a string into a user text part', () => {
    const content = toUserContent('hello');
    expect(content.role).toBe('user');
    expect(content.parts?.[0].text).toBe('hello');
  });

  it('normalizes a model-role Content to the user role', () => {
    const original = {role: 'model', parts: [{text: 'hi'}]};
    const content = toUserContent(original);
    expect(content.role).toBe('user');
    expect(content.parts?.[0].text).toBe('hi');
  });

  it('serializes a plain object as JSON', () => {
    const content = toUserContent({a: 1});
    expect(content.role).toBe('user');
    expect(content.parts?.[0].text).toBe('{"a":1}');
  });

  it('serializes an array as JSON', () => {
    expect(toUserContent([1, 'two']).parts?.[0].text).toBe('[1,"two"]');
  });

  it('serializes an object through its toJSON method', () => {
    const value = {a: 1, toJSON: () => ({b: 2})};
    expect(toUserContent(value).parts?.[0].text).toBe('{"b":2}');
  });

  it('renders a number with String', () => {
    expect(toUserContent(42).parts?.[0].text).toBe('42');
  });

  it('renders a boolean with String', () => {
    expect(toUserContent(true).parts?.[0].text).toBe('true');
  });

  it('renders null with String', () => {
    // `typeof null === 'object'`, so the object branch must exclude it.
    expect(toUserContent(null).parts?.[0].text).toBe('null');
  });

  it('keeps non-ASCII object values verbatim', () => {
    // Escaped non-ASCII bloats prompt tokens and degrades the model's
    // answers for non-English input.
    const text = toUserContent({query: 'שלום עולם', city: '北京'}).parts?.[0]
      .text;
    expect(text).toContain('שלום עולם');
    expect(text).toContain('北京');
    expect(text).not.toContain('\\u');
  });

  it('keeps non-ASCII array values verbatim', () => {
    const text = toUserContent(['שלום', '你好']).parts?.[0].text;
    expect(text).toContain('שלום');
    expect(text).toContain('你好');
    expect(text).not.toContain('\\u');
  });

  it('throws on a circular value, as json.dumps does in adk-python', () => {
    const circular: {self?: unknown} = {};
    circular.self = circular;
    expect(() => toUserContent(circular)).toThrow(TypeError);
  });
});

describe('isAudioPart', () => {
  it('reports an inline audio blob as audio', () => {
    expect(isAudioPart(audioBlobPart('audio/pcm'))).toBe(true);
  });

  it('reports an audio file reference as audio', () => {
    expect(isAudioPart(audioFilePart('audio/wav'))).toBe(true);
  });

  it('reports image and video parts as not audio', () => {
    // Only the 'audio/' top-level type counts; video and image parts must
    // survive so they still reach the model.
    expect(isAudioPart(audioBlobPart('image/png'))).toBe(false);
    expect(isAudioPart(audioFilePart('video/mp4'))).toBe(false);
  });

  it('matches the top-level type as a prefix, not a substring', () => {
    expect(isAudioPart(audioBlobPart('application/audio-ish'))).toBe(false);
  });

  it('reports a text part as not audio', () => {
    expect(isAudioPart({text: 'hello'})).toBe(false);
  });

  it('reports a blob with no MIME type as not audio', () => {
    // An unlabelled blob cannot be proven to be audio, so it is kept.
    expect(isAudioPart(audioBlobPart())).toBe(false);
  });

  it('reports a file reference with no MIME type as not audio', () => {
    expect(isAudioPart(audioFilePart())).toBe(false);
  });
});

describe('filterAudioParts', () => {
  it('drops audio parts and keeps the role and the order', () => {
    const content = {
      role: 'user',
      parts: [
        {text: 'before'},
        audioBlobPart('audio/pcm'),
        audioFilePart('audio/wav'),
        {text: 'after'},
      ],
    };

    const filtered = filterAudioParts(content);

    expect(filtered?.role).toBe('user');
    expect(filtered?.parts?.map((part) => part.text)).toEqual([
      'before',
      'after',
    ]);
  });

  it('returns undefined for an all-audio content', () => {
    // Nothing is left to send, so the caller drops the whole content rather
    // than sending one with no parts.
    const content = {role: 'user', parts: [audioBlobPart('audio/pcm')]};
    expect(filterAudioParts(content)).toBeUndefined();
  });

  it('returns undefined for an empty parts array', () => {
    expect(filterAudioParts({role: 'user', parts: []})).toBeUndefined();
  });

  it('returns undefined for a content with no parts', () => {
    expect(filterAudioParts({role: 'user'})).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const content = {
      role: 'user',
      parts: [{text: 'keep'}, audioBlobPart('audio/pcm')],
    };

    filterAudioParts(content);

    expect(content.parts).toHaveLength(2);
    expect(content.parts[1].inlineData?.mimeType).toBe('audio/pcm');
  });
});

describe('extractTextFromContent', () => {
  it('concatenates text parts with no separator', () => {
    // The model emits one logical string, chunked arbitrarily across parts.
    const content = {role: 'model', parts: [{text: 'hello '}, {text: 'world'}]};
    expect(extractTextFromContent(content)).toBe('hello world');
  });

  it('omits thought parts', () => {
    const content = {
      role: 'model',
      parts: [{text: 'reasoning', thought: true}, {text: 'answer'}],
    };
    expect(extractTextFromContent(content)).toBe('answer');
  });

  it('returns an empty string for undefined', () => {
    expect(extractTextFromContent(undefined)).toBe('');
  });

  it('returns an empty string for null', () => {
    expect(extractTextFromContent(null)).toBe('');
  });

  it('returns an empty string for a content with no text parts', () => {
    const content = {role: 'user', parts: [audioBlobPart('audio/pcm')]};
    expect(extractTextFromContent(content)).toBe('');
  });

  it('returns an empty string for a content with no parts', () => {
    expect(extractTextFromContent({role: 'user'})).toBe('');
  });
});

describe('contentUnionToUserContent', () => {
  it('returns a Content value unchanged', () => {
    const content: Content = {role: 'model', parts: [{text: 'kept'}]};
    expect(contentUnionToUserContent(content)).toBe(content);
  });

  it('converts a string to user content', () => {
    const converted = contentUnionToUserContent('hello');
    expect(converted.role).toBe('user');
    expect(converted.parts?.[0].text).toBe('hello');
  });

  it('converts a single part', () => {
    const part: Part = {text: 'from part'};
    const converted = contentUnionToUserContent(part);
    expect(converted.role).toBe('user');
    expect(converted.parts?.[0].text).toBe('from part');
  });

  it('converts a list of parts and keeps their order', () => {
    const converted = contentUnionToUserContent([
      {text: 'first'},
      {text: 'second'},
    ]);
    expect(converted.parts?.map((part) => part.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('raises the SDK error for a value that is not a part list', () => {
    expect(() => contentUnionToUserContent([])).toThrow(/empty array/);
    expect(() => contentUnionToUserContent({})).toThrow(
      /must be a Part object/,
    );
  });
});
