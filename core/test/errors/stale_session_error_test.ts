/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isStaleSessionError, StaleSessionError} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('StaleSessionError', () => {
  it('carries the default message', () => {
    const error = new StaleSessionError();

    expect(error.message).toBe(
      'The session has been modified in storage since it was loaded. ' +
        'Please reload the session before appending more events.',
    );
  });

  it('accepts a custom message', () => {
    expect(new StaleSessionError('gone').message).toBe('gone');
  });

  it('is an Error named StaleSessionError', () => {
    const error = new StaleSessionError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StaleSessionError');
  });

  it('is recognised by its type guard', () => {
    expect(isStaleSessionError(new StaleSessionError())).toBe(true);
  });

  it('does not recognise another error as a stale session', () => {
    expect(isStaleSessionError(new Error('other'))).toBe(false);
    expect(isStaleSessionError('not an error')).toBe(false);
  });
});
