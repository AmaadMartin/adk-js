/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {safeJsonLoads} from '../../src/utils/json_utils.js';

describe('safeJsonLoads', () => {
  it('parses an object', () => {
    expect(safeJsonLoads('{"city": "Paris", "days": 2}')).toEqual({
      city: 'Paris',
      days: 2,
    });
  });

  it('parses a scalar', () => {
    expect(safeJsonLoads('42')).toBe(42);
  });

  it('reports malformed input as an Error, not a SyntaxError', () => {
    expect(() => safeJsonLoads('{"city": "Par')).toThrowError(
      /^Invalid JSON: /,
    );
    expect(() => safeJsonLoads('{"city": "Par')).not.toThrowError(SyntaxError);
  });

  it('names the source of the text when a context is given', () => {
    expect(() => safeJsonLoads('{"city": "Par', 'session state')).toThrowError(
      /^Invalid JSON in session state: /,
    );
  });

  it('keeps the parse failure as the cause', () => {
    let caught: unknown;
    try {
      safeJsonLoads('not json');
    } catch (err: unknown) {
      caught = err;
    }
    if (!(caught instanceof Error)) {
      return expect.fail('safeJsonLoads must throw an Error');
    }
    expect(caught.cause).toBeInstanceOf(SyntaxError);
  });
});
