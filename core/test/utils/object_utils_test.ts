/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {isRecord} from '../../src/utils/object_utils.js';

describe('isRecord', () => {
  it.each([{}, {a: 1}, Object.create(null), new Date()])(
    'accepts the object %o',
    (value) => {
      expect(isRecord(value)).toBe(true);
    },
  );

  it.each([null, undefined, 'text', 0, false, [], [1, 2], Symbol('x')])(
    'rejects the non-object %o',
    (value) => {
      expect(isRecord(value)).toBe(false);
    },
  );

  it('narrows the value so its properties can be read', () => {
    const value: unknown = {answer: 42};

    expect(isRecord(value) ? value['answer'] : undefined).toBe(42);
  });
});
