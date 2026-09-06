/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  isInputValidationError,
  NotFoundError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('InputValidationError', () => {
  it('defaults the message when none is supplied', () => {
    expect(new InputValidationError().message).toBe('Invalid input.');
    expect(new InputValidationError(undefined).message).toBe('Invalid input.');
  });

  it('stores a supplied message verbatim', () => {
    expect(new InputValidationError('appName is required.').message).toBe(
      'appName is required.',
    );
    expect(new InputValidationError('').message).toBe('');
  });

  it('sets name', () => {
    expect(new InputValidationError().name).toBe('InputValidationError');
  });

  it('is an instance of itself and of Error', () => {
    const error = new InputValidationError();
    expect(error).toBeInstanceOf(InputValidationError);
    expect(error).toBeInstanceOf(Error);
  });

  it('is not an instance of a sibling error class', () => {
    expect(new InputValidationError()).not.toBeInstanceOf(NotFoundError);
  });

  it('can be thrown and caught by type', () => {
    expect(() => {
      throw new InputValidationError('boom');
    }).toThrow(InputValidationError);
  });

  it('carries a supplied cause', () => {
    const cause = new Error('the schema rejected the value');

    expect(new InputValidationError('boom', {cause}).cause).toBe(cause);
    expect(new InputValidationError('boom').cause).toBeUndefined();
  });
});

describe('isInputValidationError', () => {
  it('accepts an InputValidationError', () => {
    expect(isInputValidationError(new InputValidationError())).toBe(true);
  });

  it('rejects a plain Error and a sibling error class', () => {
    expect(isInputValidationError(new Error('boom'))).toBe(false);
    expect(isInputValidationError(new NotFoundError())).toBe(false);
  });

  it('rejects a value that is not an Error', () => {
    expect(isInputValidationError({name: 'InputValidationError'})).toBe(false);
  });

  it('accepts an error from another copy of the package', () => {
    const fromAnotherCopy = new Error('Invalid input.');
    fromAnotherCopy.name = 'InputValidationError';

    expect(isInputValidationError(fromAnotherCopy)).toBe(true);
  });
});
