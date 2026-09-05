/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isRecord} from '../../src/utils/object_utils.js';

describe('isRecord', () => {
  it('accepts a keyed object', () => {
    expect(isRecord({a: 1})).toBe(true);
    expect(isRecord({})).toBe(true);
  });

  it('rejects an array', () => {
    expect(isRecord([1, 2, 3])).toBe(false);
    expect(isRecord([])).toBe(false);
  });

  it('rejects null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('rejects a primitive and undefined', () => {
    expect(isRecord('text')).toBe(false);
    expect(isRecord(7)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
