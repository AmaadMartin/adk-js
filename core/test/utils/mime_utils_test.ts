/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {baseMimeType} from '../../src/utils/mime_utils.js';

describe('baseMimeType', () => {
  it('returns a bare MIME type unchanged', () => {
    expect(baseMimeType('application/pdf')).toBe('application/pdf');
  });

  it('strips a parameter', () => {
    expect(baseMimeType('text/csv; charset=utf-8')).toBe('text/csv');
  });

  it('strips several parameters', () => {
    expect(baseMimeType('text/plain;charset=utf-8;format=flowed')).toBe(
      'text/plain',
    );
  });

  it('trims the whitespace around the type', () => {
    expect(baseMimeType('  image/png  ')).toBe('image/png');
  });

  it('returns an empty string for an empty input', () => {
    expect(baseMimeType('')).toBe('');
  });
});
