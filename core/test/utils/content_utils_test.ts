/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isContent} from '../../src/utils/content_utils.js';

describe('isContent', () => {
  it('accepts a Content, including one with no parts', () => {
    expect(isContent({parts: [{text: 'hi'}]})).toBe(true);
    expect(isContent({role: 'user', parts: []})).toBe(true);
  });

  it('rejects a bare Part', () => {
    expect(isContent({text: 'hi'})).toBe(false);
  });

  it('rejects a value whose parts is not an array', () => {
    expect(isContent({parts: 'hi'})).toBe(false);
  });

  it('rejects null and a primitive without throwing', () => {
    expect(isContent(null)).toBe(false);
    expect(isContent(42)).toBe(false);
    expect(isContent('hi')).toBe(false);
    expect(isContent(undefined)).toBe(false);
  });
});
