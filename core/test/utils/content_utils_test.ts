/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {filterAudioParts, isAudioPart} from '../../src/utils/content_utils.js';

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
