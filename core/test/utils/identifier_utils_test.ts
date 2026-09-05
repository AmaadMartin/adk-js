/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isIdentifier} from '../../src/utils/identifier_utils.js';

describe('isIdentifier', () => {
  it('accepts a letter, underscore or dollar start', () => {
    expect(isIdentifier('foo')).toBe(true);
    expect(isIdentifier('_foo')).toBe(true);
    expect(isIdentifier('$foo')).toBe(true);
    expect(isIdentifier('F')).toBe(true);
  });

  it('accepts digits, underscores and hyphens after the first character', () => {
    expect(isIdentifier('foo_bar')).toBe(true);
    expect(isIdentifier('foo-bar')).toBe(true);
    expect(isIdentifier('foo9')).toBe(true);
    expect(isIdentifier('__START__')).toBe(true);
  });

  it('accepts a non-ASCII letter', () => {
    expect(isIdentifier('agenté')).toBe(true);
    expect(isIdentifier('日本語')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isIdentifier('')).toBe(false);
  });

  it('rejects a digit or a hyphen as the first character', () => {
    expect(isIdentifier('1abc')).toBe(false);
    expect(isIdentifier('-abc')).toBe(false);
  });

  it('rejects whitespace and punctuation', () => {
    expect(isIdentifier('my name')).toBe(false);
    expect(isIdentifier(' foo')).toBe(false);
    expect(isIdentifier('foo ')).toBe(false);
    expect(isIdentifier('a.b')).toBe(false);
    expect(isIdentifier('a!')).toBe(false);
    expect(isIdentifier('a/b')).toBe(false);
  });

  it('rejects a name that is only valid in part', () => {
    expect(isIdentifier('foo\nbar')).toBe(false);
    expect(isIdentifier('foo bar baz')).toBe(false);
  });
});
