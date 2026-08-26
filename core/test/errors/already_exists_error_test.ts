/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AlreadyExistsError, isAlreadyExistsError} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('AlreadyExistsError', () => {
  it('defaults to the parity message', () => {
    expect(new AlreadyExistsError().message).toBe(
      'The resource already exists.',
    );
  });

  it('keeps a custom message', () => {
    expect(
      new AlreadyExistsError('Session with id s1 already exists.').message,
    ).toBe('Session with id s1 already exists.');
  });

  it('names itself AlreadyExistsError', () => {
    expect(new AlreadyExistsError().name).toBe('AlreadyExistsError');
  });

  it('is an Error with a stack', () => {
    const error = new AlreadyExistsError();

    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toBeDefined();
  });
});

describe('isAlreadyExistsError', () => {
  it('accepts an AlreadyExistsError', () => {
    expect(isAlreadyExistsError(new AlreadyExistsError())).toBe(true);
  });

  it('accepts an error from another copy of the package', () => {
    const foreign = new Error('Session with id s1 already exists.');
    foreign.name = 'AlreadyExistsError';

    expect(isAlreadyExistsError(foreign)).toBe(true);
  });

  it('rejects other errors and non-errors', () => {
    expect(isAlreadyExistsError(new Error('already exists'))).toBe(false);
    expect(isAlreadyExistsError(new TypeError('already exists'))).toBe(false);
    expect(isAlreadyExistsError(undefined)).toBe(false);
    expect(isAlreadyExistsError(null)).toBe(false);
    expect(isAlreadyExistsError({name: 'AlreadyExistsError'})).toBe(false);
  });
});
