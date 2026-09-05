/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {asSafePartForLlm} from '../../src/utils/part_utils.js';

function inlinePart(mimeType: string | undefined, text?: string): Part {
  return {
    inlineData: {
      mimeType,
      data:
        text === undefined ? undefined : Buffer.from(text).toString('base64'),
    },
  };
}

describe('asSafePartForLlm', () => {
  it('returns a part without inline data by reference', () => {
    const part: Part = {text: 'hello'};

    expect(asSafePartForLlm(part, 'note')).toBe(part);
  });

  it.each(['image/png', 'audio/mpeg', 'video/mp4', 'application/pdf'])(
    'keeps inline data the model can read: %s',
    (mimeType) => {
      const part = inlinePart(mimeType, 'bytes');

      expect(asSafePartForLlm(part, 'artifact')).toBe(part);
    },
  );

  it('keeps a supported type carrying a parameter', () => {
    const part = inlinePart('application/pdf; charset=binary', 'bytes');

    expect(asSafePartForLlm(part, 'artifact')).toBe(part);
  });

  it.each([
    'text/plain',
    'text/csv',
    'application/csv',
    'application/json',
    'application/xml',
  ])('decodes a text-like type: %s', (mimeType) => {
    const part = inlinePart(mimeType, 'line one');

    expect(asSafePartForLlm(part, 'artifact')).toEqual({text: 'line one'});
  });

  it('decodes a text-like type declared with a charset parameter', () => {
    const part = inlinePart('application/json; charset=utf-8', '{"a":1}');

    expect(asSafePartForLlm(part, 'artifact')).toEqual({text: '{"a":1}'});
  });

  it('describes a binary type by name and size', () => {
    const part = inlinePart('application/zip', 'x'.repeat(2048));

    expect(asSafePartForLlm(part, 'bundle')).toEqual({
      text: '[Binary artifact: bundle, type: application/zip, size: 2.0 KB. Content cannot be displayed inline.]',
    });
  });

  it('falls back to the octet-stream type when none is declared', () => {
    const part = inlinePart(undefined, 'x'.repeat(1024));

    expect(asSafePartForLlm(part, 'blob')).toEqual({
      text: '[Binary artifact: blob, type: application/octet-stream, size: 1.0 KB. Content cannot be displayed inline.]',
    });
  });

  it('reports inline data that carries no bytes', () => {
    const part = inlinePart('application/zip');

    expect(asSafePartForLlm(part, 'bundle')).toEqual({
      text: '[Artifact: bundle, type: application/zip. No inline data was provided.]',
    });
  });

  it('reports missing bytes with the octet-stream type when none is declared', () => {
    const part = inlinePart(undefined);

    expect(asSafePartForLlm(part, 'blob')).toEqual({
      text: '[Artifact: blob, type: application/octet-stream. No inline data was provided.]',
    });
  });
});
