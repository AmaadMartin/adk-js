/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isRecord} from '../../src/utils/record_utils.js';

describe('isRecord', () => {
  it.each([[{}], [{a: 1}], [new Date()]])('accepts %o', (value) => {
    expect(isRecord(value)).toBe(true);
  });

  it.each([[null], [undefined], ['text'], [7], [[1, 2]]])(
    'rejects %o',
    (value) => {
      expect(isRecord(value)).toBe(false);
    },
  );
});
