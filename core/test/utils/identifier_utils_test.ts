/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isIdentifier} from '../../src/utils/identifier_utils.js';

describe('isIdentifier', () => {
  it('accepts a name starting with a letter, an underscore or a dollar', () => {
    expect(isIdentifier('agent')).toBe(true);
    expect(isIdentifier('Agent')).toBe(true);
    expect(isIdentifier('_private')).toBe(true);
    expect(isIdentifier('$root')).toBe(true);
    expect(isIdentifier('__START__')).toBe(true);
  });

  it('accepts digits, hyphens, underscores and dollars after the first', () => {
    expect(isIdentifier('n1')).toBe(true);
    expect(isIdentifier('snake_case')).toBe(true);
    expect(isIdentifier('camelCase')).toBe(true);
    expect(isIdentifier('with-hyphen')).toBe(true);
    expect(isIdentifier('a$b')).toBe(true);
  });

  it('accepts Unicode ID_Start and ID_Continue characters', () => {
    expect(isIdentifier('caf\u00e9')).toBe(true);
    expect(isIdentifier('\u0394elta')).toBe(true);
    expect(isIdentifier('\u65e5\u672c\u8a9e')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isIdentifier('')).toBe(false);
  });

  it('rejects a first character that is not ID_Start, $ or _', () => {
    expect(isIdentifier('1abc')).toBe(false);
    expect(isIdentifier('-abc')).toBe(false);
    expect(isIdentifier(' abc')).toBe(false);
  });

  it('rejects a later character that is not ID_Continue, $, _ or -', () => {
    expect(isIdentifier('my node')).toBe(false);
    expect(isIdentifier('a.b')).toBe(false);
    expect(isIdentifier('a/b')).toBe(false);
    expect(isIdentifier('a\u00a0b')).toBe(false);
  });

  it('rejects an emoji, which is neither ID_Start nor ID_Continue', () => {
    expect(isIdentifier('\u{1f600}start')).toBe(false);
    expect(isIdentifier('emoji\u{1f600}')).toBe(false);
  });
});
