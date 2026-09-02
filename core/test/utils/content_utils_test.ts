/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {isContent, toUserContent} from '../../src/utils/content_utils.js';

describe('content_utils', () => {
  describe('isContent', () => {
    it('accepts an object with an array of parts', () => {
      expect(isContent({parts: []})).toBe(true);
      expect(isContent({role: 'model', parts: [{text: 'x'}]})).toBe(true);
    });

    it('rejects an object whose parts is not an array', () => {
      expect(isContent({parts: 'x'})).toBe(false);
    });

    it('rejects an object without parts', () => {
      expect(isContent({text: 'x'})).toBe(false);
    });

    it('rejects a string', () => {
      expect(isContent('x')).toBe(false);
    });

    it('rejects null', () => {
      expect(isContent(null)).toBe(false);
    });
  });

  describe('toUserContent', () => {
    it('returns the same object for a Content input', () => {
      const content: Content = {role: 'model', parts: [{text: 'hi'}]};
      expect(toUserContent(content)).toBe(content);
    });

    it('wraps a string as user content', () => {
      expect(toUserContent('hello')).toEqual({
        role: 'user',
        parts: [{text: 'hello'}],
      });
    });

    it('wraps a part as user content', () => {
      const part: Part = {text: 'from Part'};
      expect(toUserContent(part)).toEqual({
        role: 'user',
        parts: [{text: 'from Part'}],
      });
    });

    it('wraps a list of parts as user content', () => {
      const parts: Part[] = [{text: 'part1'}, {text: 'part2'}];
      expect(toUserContent(parts)).toEqual({
        role: 'user',
        parts: [{text: 'part1'}, {text: 'part2'}],
      });
    });
  });
});
