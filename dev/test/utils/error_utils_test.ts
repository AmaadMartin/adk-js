/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {describe, expect, it} from 'vitest';

import {errorMessage} from '../../src/utils/error_utils.js';

describe('error_utils', () => {
  describe('errorMessage', () => {
    it('returns the message of an Error', () => {
      expect(errorMessage(new Error('boom'))).toBe('boom');
    });

    it('returns the message of an Error subclass', () => {
      expect(errorMessage(new TypeError('bad'))).toBe('bad');
    });

    it('returns the empty message of an Error without rerouting it', () => {
      expect(errorMessage(new Error(''))).toBe('');
    });

    it('returns a thrown string unchanged', () => {
      expect(errorMessage('boom')).toBe('boom');
    });

    it('stringifies a thrown number', () => {
      expect(errorMessage(42)).toBe('42');
    });

    it('stringifies undefined and null', () => {
      expect(errorMessage(undefined)).toBe('undefined');
      expect(errorMessage(null)).toBe('null');
    });

    it('stringifies a plain object to [object Object]', () => {
      expect(errorMessage({code: 'ENOENT'})).toBe('[object Object]');
    });
  });
});
