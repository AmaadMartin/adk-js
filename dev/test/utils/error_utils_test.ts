/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {errorMessage} from '../../src/utils/error_utils.js';

describe('errorMessage', () => {
  it('takes the message of an Error', () => {
    expect(errorMessage(new Error('disk is full'))).toBe('disk is full');
  });

  it('describes a thrown value that is not an Error', () => {
    expect(errorMessage('disk is full')).toBe('disk is full');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});
