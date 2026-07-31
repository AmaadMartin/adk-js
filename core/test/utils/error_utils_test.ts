/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ApiError} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {resolveErrorType} from '../../src/utils/error_utils.js';

class ClassifiedError extends Error {
  constructor(
    message: string,
    readonly errorType: string,
  ) {
    super(message);
    this.name = 'ClassifiedError';
  }
}

describe('resolveErrorType', () => {
  it('prefers an error type the error classified itself with', () => {
    expect(
      resolveErrorType(new ClassifiedError('boom', 'MCP_TOOL_ERROR')),
    ).toBe('MCP_TOOL_ERROR');
  });

  it('reports the HTTP status of a genai API error', () => {
    const error = new ApiError({message: 'rate limited', status: 429});

    expect(resolveErrorType(error)).toBe('429');
  });

  it('prefers a classified error type over an HTTP status', () => {
    const error: Error & {errorType?: string} = new ApiError({
      message: 'rate limited',
      status: 429,
    });
    error.errorType = 'QUOTA_EXCEEDED';

    expect(resolveErrorType(error)).toBe('QUOTA_EXCEEDED');
  });

  it('ignores an error type that is not a string', () => {
    const error: Error & {errorType?: number} = new TypeError('boom');
    error.errorType = 503;

    expect(resolveErrorType(error)).toBe('TypeError');
  });

  it('falls back to the error name', () => {
    expect(resolveErrorType(new TypeError('not a function'))).toBe('TypeError');
  });

  it('falls back to the class name when the name has been blanked out', () => {
    const error = new TypeError('not a function');
    error.name = '';

    expect(resolveErrorType(error)).toBe('TypeError');
  });

  it('stringifies a thrown value that is not an object', () => {
    expect(resolveErrorType('just a string')).toBe('just a string');
  });

  it('stringifies a thrown null', () => {
    expect(resolveErrorType(null)).toBe('null');
  });
});
