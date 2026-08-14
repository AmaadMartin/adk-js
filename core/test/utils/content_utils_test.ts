/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Content, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {contentUnionToText} from '../../src/utils/content_utils.js';

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
