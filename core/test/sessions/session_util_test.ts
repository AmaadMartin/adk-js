/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {decodeModel} from '@google/adk/sessions/session_util.js';
import {describe, expect, it} from 'vitest';

describe('decodeModel', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['the string a session store persisted for SQL NULL', 'null'],
    ['a plain string', 's'],
    ['a number', 0],
    ['a boolean', false],
    ['an array', []],
  ])('drops %s', (_, value) => {
    expect(decodeModel(value)).toBeUndefined();
  });

  it('returns an object payload unchanged', () => {
    const payload = {a: 1};

    expect(decodeModel<{a: number}>(payload)).toBe(payload);
  });

  it('returns an empty object, which is a valid payload', () => {
    expect(decodeModel({})).toEqual({});
  });
});
