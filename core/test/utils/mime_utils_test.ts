/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isGeminiInlineMimeTypeSupported,
  isTextLikeMimeType,
  normalizeMimeType,
} from '../../src/utils/mime_utils.js';

describe('normalizeMimeType', () => {
  it('strips parameters and trims the result', () => {
    expect(normalizeMimeType('text/csv; charset=utf-8')).toEqual('text/csv');
    expect(normalizeMimeType('  text/plain  ')).toEqual('text/plain');
  });

  it('returns undefined for an absent or empty mime type', () => {
    expect(normalizeMimeType(undefined)).toBeUndefined();
    expect(normalizeMimeType('')).toBeUndefined();
  });
});

describe('isGeminiInlineMimeTypeSupported', () => {
  it.each(['image/png', 'audio/mpeg', 'video/mp4', 'application/pdf'])(
    'accepts %s',
    (mimeType) => {
      expect(isGeminiInlineMimeTypeSupported(mimeType)).toBe(true);
    },
  );

  it.each(['image/svg', 'image/svg+xml', 'image/xml'])(
    'rejects %s even though it matches a supported prefix',
    (mimeType) => {
      expect(isGeminiInlineMimeTypeSupported(mimeType)).toBe(false);
    },
  );

  it('rejects an svg mime type carrying parameters', () => {
    expect(
      isGeminiInlineMimeTypeSupported('image/svg+xml; charset=utf-8'),
    ).toBe(false);
  });

  it.each(['application/csv', 'application/octet-stream'])(
    'rejects %s',
    (mimeType) => {
      expect(isGeminiInlineMimeTypeSupported(mimeType)).toBe(false);
    },
  );

  it('rejects an absent mime type', () => {
    expect(isGeminiInlineMimeTypeSupported(undefined)).toBe(false);
  });
});

describe('isTextLikeMimeType', () => {
  it.each([
    'text/plain',
    'application/csv',
    'application/json',
    'application/svg+xml',
    'application/xml',
    'image/svg',
    'image/svg+xml',
    'image/xml',
  ])('treats %s as text', (mimeType) => {
    expect(isTextLikeMimeType(mimeType)).toBe(true);
  });

  it.each(['application/octet-stream', 'image/png'])(
    'does not treat %s as text',
    (mimeType) => {
      expect(isTextLikeMimeType(mimeType)).toBe(false);
    },
  );
});
