/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NotFoundError, NotImplementedError} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('NotImplementedError', () => {
  it('defaults the message when none is supplied', () => {
    expect(new NotImplementedError().message).toBe(
      'This operation is not implemented.',
    );
    expect(new NotImplementedError(undefined).message).toBe(
      'This operation is not implemented.',
    );
  });

  it('stores a supplied message verbatim', () => {
    expect(
      new NotImplementedError('getUserState is unsupported.').message,
    ).toBe('getUserState is unsupported.');
    expect(new NotImplementedError('').message).toBe('');
  });

  it('sets name', () => {
    expect(new NotImplementedError().name).toBe('NotImplementedError');
  });

  it('is an instance of itself and of Error', () => {
    const error = new NotImplementedError();
    expect(error).toBeInstanceOf(NotImplementedError);
    expect(error).toBeInstanceOf(Error);
  });

  it('is not an instance of a sibling error class', () => {
    expect(new NotImplementedError()).not.toBeInstanceOf(NotFoundError);
  });

  it('can be thrown and caught by type', () => {
    expect(() => {
      throw new NotImplementedError('boom');
    }).toThrow(NotImplementedError);
  });
});
