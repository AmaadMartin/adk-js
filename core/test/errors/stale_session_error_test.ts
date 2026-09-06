/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isStaleSessionError,
  SessionNotFoundError,
  StaleSessionError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** The message the class carries when the caller supplies none. */
const DEFAULT_MESSAGE =
  'The session has been modified in storage since it was loaded. ' +
  'Please reload the session before appending more events.';

describe('StaleSessionError', () => {
  it('defaults the message when none is supplied', () => {
    expect(new StaleSessionError().message).toBe(DEFAULT_MESSAGE);
    expect(new StaleSessionError(undefined).message).toBe(DEFAULT_MESSAGE);
  });

  it('carries the default message', () => {
    const error = new StaleSessionError();

    expect(error.message).toBe(
      'The session has been modified in storage since it was loaded. ' +
        'Please reload the session before appending more events.',
    );
  });

  it('stores a supplied message verbatim', () => {
    expect(new StaleSessionError('Reload session 42.').message).toBe(
      'Reload session 42.',
    );
    expect(new StaleSessionError('').message).toBe('');
  });

  it('accepts a custom message', () => {
    expect(new StaleSessionError('gone').message).toBe('gone');
  });

  it('sets name', () => {
    expect(new StaleSessionError().name).toBe('StaleSessionError');
  });

  it('is an Error named StaleSessionError', () => {
    const error = new StaleSessionError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StaleSessionError');
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

  it('is recognised by its type guard', () => {
    expect(isStaleSessionError(new StaleSessionError())).toBe(true);
  });

  it('does not recognise another error as a stale session', () => {
    expect(isStaleSessionError(new Error('other'))).toBe(false);
    expect(isStaleSessionError('not an error')).toBe(false);
  });

  it('can be thrown and caught by type', () => {
    expect(() => {
      throw new StaleSessionError('boom');
    }).toThrow(StaleSessionError);
  });
});
