/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isResourceExhaustedError, ResourceExhaustedError} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  asResourceExhaustedError,
  RESOURCE_EXHAUSTED_MITIGATION_MESSAGE,
} from '../../src/errors/resource_exhausted_error.js';

function apiError(message: string, status: number): Error {
  return Object.assign(new Error(message), {status});
}

describe('ResourceExhaustedError', () => {
  it('carries the mitigation guide and the original message', () => {
    const cause = apiError('Quota exceeded for requests', 429);

    const error = new ResourceExhaustedError(cause);

    expect(error.message).toContain(RESOURCE_EXHAUSTED_MITIGATION_MESSAGE);
    expect(error.message).toContain('Quota exceeded for requests');
  });

  it('reports status 429 and its own name', () => {
    const error = new ResourceExhaustedError(new Error('boom'));

    expect(error.status).toBe(429);
    expect(error.name).toBe('ResourceExhaustedError');
  });

  it('keeps the original error as the cause', () => {
    const cause = new Error('boom');

    expect(new ResourceExhaustedError(cause).cause).toBe(cause);
  });
});

describe('isResourceExhaustedError', () => {
  it('accepts an error this package built', () => {
    expect(
      isResourceExhaustedError(new ResourceExhaustedError(new Error('boom'))),
    ).toBe(true);
  });

  it('accepts an error built by a second copy of the package', () => {
    // Two copies of adk-js in one runtime would fail an `instanceof` check
    // between them, so the guard must match on `name` instead.
    const foreign = new Error('from another copy');
    foreign.name = 'ResourceExhaustedError';

    expect(foreign).not.toBeInstanceOf(ResourceExhaustedError);
    expect(isResourceExhaustedError(foreign)).toBe(true);
  });

  it('rejects a plain error', () => {
    expect(isResourceExhaustedError(new Error('boom'))).toBe(false);
  });

  it('rejects a non-error that only carries the name', () => {
    expect(isResourceExhaustedError({name: 'ResourceExhaustedError'})).toBe(
      false,
    );
  });
});

describe('asResourceExhaustedError', () => {
  it('converts an SDK error with status 429', () => {
    const cause = apiError('Quota exceeded', 429);

    const converted = asResourceExhaustedError(cause);

    expect(isResourceExhaustedError(converted)).toBe(true);
    expect(converted?.cause).toBe(cause);
  });

  it('leaves an SDK error with another status alone', () => {
    expect(asResourceExhaustedError(apiError('Server error', 500))).toBe(
      undefined,
    );
  });

  it('leaves an error without a status alone', () => {
    expect(asResourceExhaustedError(new Error('boom'))).toBe(undefined);
  });

  it('leaves a thrown non-error alone', () => {
    expect(asResourceExhaustedError({status: 429})).toBe(undefined);
  });
});
