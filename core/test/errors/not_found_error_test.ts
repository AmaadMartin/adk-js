/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {NotFoundError} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('errors/not_found_error', () => {
  it('uses the default message', () => {
    expect(new NotFoundError().message).toBe(
      'The requested item was not found.',
    );
  });

  it('accepts a custom message', () => {
    expect(new NotFoundError('custom message').message).toBe('custom message');
  });

  it('is an instance of Error', () => {
    expect(new NotFoundError()).toBeInstanceOf(Error);
  });

  it('sets the error name', () => {
    expect(new NotFoundError().name).toBe('NotFoundError');
  });
});
