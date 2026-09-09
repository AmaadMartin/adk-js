/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {isContent, toUserContent} from '../../src/utils/content_utils.js';

describe('isContent', () => {
  it('is true for objects with a parts array', () => {
    expect(isContent({parts: []})).toBe(true);
    expect(isContent({role: 'user', parts: [{text: 'x'}]})).toBe(true);
  });

  it('is false without a parts array', () => {
    expect(isContent({role: 'user'})).toBe(false);
    expect(isContent({parts: 'x'})).toBe(false);
    expect(isContent('x')).toBe(false);
    expect(isContent(null)).toBe(false);
  });
});

describe('toUserContent', () => {
  it('returns a Content value unchanged', () => {
    const content: Content = {role: 'model', parts: [{text: 'kept'}]};
    expect(toUserContent(content)).toBe(content);
  });

  it('converts a string to user content', () => {
    const converted = toUserContent('hello');
    expect(converted.role).toBe('user');
    expect(converted.parts?.[0].text).toBe('hello');
  });

  it('converts a single part', () => {
    const part: Part = {text: 'from part'};
    const converted = toUserContent(part);
    expect(converted.role).toBe('user');
    expect(converted.parts?.[0].text).toBe('from part');
  });

  it('converts a list of parts and keeps their order', () => {
    const converted = toUserContent([{text: 'first'}, {text: 'second'}]);
    expect(converted.parts?.map((part) => part.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('raises the SDK error for a value that is not a part list', () => {
    expect(() => toUserContent([])).toThrow(/empty array/);
    expect(() => toUserContent({})).toThrow(/must be a Part object/);
  });
});
