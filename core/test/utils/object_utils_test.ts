/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isRecord} from '../../src/utils/object_utils.js';

describe('isRecord', () => {
  it('accepts a plain object', () => {
    expect(isRecord({a: 1})).toBe(true);
    expect(isRecord({})).toBe(true);
  });

  it('rejects an array', () => {
    // An array is an object, so the callers that decode JSON rely on this to
    // tell a `{...}` payload from a `[...]` one.
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord([])).toBe(false);
  });

  it('rejects null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it.each([undefined, 'text', 42, true])(
    'rejects the primitive %s',
    (value) => {
      expect(isRecord(value)).toBe(false);
    },
  );
});
