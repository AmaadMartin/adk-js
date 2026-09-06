/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SessionNotFoundError, StaleSessionError} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('StaleSessionError', () => {
  it('defaults the message when none is supplied', () => {
    expect(new StaleSessionError().message).toBe(
      'The session has been modified in storage since it was loaded.',
    );
    expect(new StaleSessionError(undefined).message).toBe(
      'The session has been modified in storage since it was loaded.',
    );
  });

  it('stores a supplied message verbatim', () => {
    expect(new StaleSessionError('Reload session 42.').message).toBe(
      'Reload session 42.',
    );
    expect(new StaleSessionError('').message).toBe('');
  });

  it('sets name', () => {
    expect(new StaleSessionError().name).toBe('StaleSessionError');
  });

  it('is an instance of itself and of Error', () => {
    const error = new StaleSessionError();
    expect(error).toBeInstanceOf(StaleSessionError);
    expect(error).toBeInstanceOf(Error);
  });

  it('is not an instance of a sibling error class', () => {
    // A stale write is not a missing session, so a caller that only handles
    // SessionNotFoundError must not swallow it.
    expect(new StaleSessionError()).not.toBeInstanceOf(SessionNotFoundError);
  });

  it('can be thrown and caught by type', () => {
    expect(() => {
      throw new StaleSessionError('boom');
    }).toThrow(StaleSessionError);
  });
});
