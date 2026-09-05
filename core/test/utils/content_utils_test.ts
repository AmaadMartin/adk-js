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
