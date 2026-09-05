/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  asRecord,
  errorMessage,
  errorName,
} from '../../src/utils/error_utils.js';

describe('asRecord', () => {
  it('returns an object unchanged', () => {
    const value = {status: 429};
    expect(asRecord(value)).toBe(value);
  });

  it('returns undefined for null and for a primitive', () => {
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord('rate limit')).toBeUndefined();
    expect(asRecord(undefined)).toBeUndefined();
  });
});

describe('errorMessage', () => {
  it('returns the message of an Error', () => {
    expect(errorMessage(new TypeError('bad input'))).toBe('bad input');
  });

  it('stringifies a thrown value that is not an Error', () => {
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(42)).toBe('42');
  });
});

describe('errorName', () => {
  it('returns the class name of an Error, never its message', () => {
    // The message is what a library may build a credential into, so callers
    // handling secrets log this instead.
    expect(errorName(new Error('token: secret-value'))).toBe('Error');
    expect(errorName(new TypeError('token: secret-value'))).toBe('TypeError');
  });

  it('returns the class name of an Error subclass', () => {
    class OidcFailure extends Error {
      override readonly name = 'OidcFailure';
    }
    expect(errorName(new OidcFailure('token: secret-value'))).toBe(
      'OidcFailure',
    );
  });

  it('returns the typeof a thrown value that is not an Error', () => {
    expect(errorName('secret-value')).toBe('string');
    expect(errorName({token: 'secret-value'})).toBe('object');
    expect(errorName(undefined)).toBe('undefined');
  });
});
