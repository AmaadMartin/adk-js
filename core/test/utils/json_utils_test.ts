/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {asJsonObject, readString} from '../../src/utils/json_utils.js';

describe('asJsonObject', () => {
  it('returns a plain object unchanged', () => {
    expect(asJsonObject({a: 1})).toEqual({a: 1});
  });

  it('rejects null, an array and a primitive', () => {
    expect(asJsonObject(null)).toBeUndefined();
    expect(asJsonObject([1, 2])).toBeUndefined();
    expect(asJsonObject('text')).toBeUndefined();
    expect(asJsonObject(undefined)).toBeUndefined();
  });
});

describe('readString', () => {
  it('returns the string value of a field', () => {
    expect(readString({name: 'value'}, 'name')).toBe('value');
  });

  it('returns an empty string for a missing or non-string field', () => {
    expect(readString({}, 'name')).toBe('');
    expect(readString({name: 42}, 'name')).toBe('');
  });
});
