/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {toErrorMessage} from '../../src/utils/error_utils.js';

describe('toErrorMessage', () => {
  it('reads the message of an Error', () => {
    expect(toErrorMessage(new Error('agent exploded'))).toBe('agent exploded');
  });

  it('reads a subclass of Error', () => {
    expect(toErrorMessage(new SyntaxError('bad token'))).toBe('bad token');
  });

  it.each([
    ['plain text', 'plain text'],
    [42, '42'],
    [undefined, 'undefined'],
    [{code: 7}, '[object Object]'],
  ])('stringifies the thrown %o', (thrown, expected) => {
    expect(toErrorMessage(thrown)).toBe(expected);
  });
});
