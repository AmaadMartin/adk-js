/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
// Not part of the public entry point: an internal helper stays internal.
import {isRecord} from '../../src/utils/object_utils.js';

describe('isRecord', () => {
  it('accepts a plain object', () => {
    expect(isRecord({a: 1})).toBe(true);
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it('rejects an array, so a field read cannot hit an index', () => {
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord([])).toBe(false);
  });

  it('rejects null and every primitive', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord('text')).toBe(false);
    expect(isRecord(7)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});
