/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {unwrapResponse} from '../../src/workflow/utils/rehydration_utils.js';

/**
 * Ports the `_unwrap_response` block of `google/adk-python`
 * `tests/unittests/workflow/utils/test_rehydration_utils.py`, so both runtimes
 * hand the same value to a node.
 */
describe('unwrapResponse', () => {
  it('parses a wrapped JSON object, as the web frontend sends it', () => {
    expect(unwrapResponse({result: '{"approved": false}'})).toEqual({
      approved: false,
    });
  });

  it('parses a wrapped JSON array', () => {
    expect(unwrapResponse({result: '[1, 2, 3]'})).toEqual([1, 2, 3]);
  });

  it('parses a wrapped JSON scalar to its JSON type', () => {
    expect(unwrapResponse({result: '42'})).toBe(42);
    expect(unwrapResponse({result: 'true'})).toBe(true);
  });

  it('keeps a wrapped string that is not JSON', () => {
    expect(unwrapResponse({result: 'plain text'})).toBe('plain text');
    expect(unwrapResponse({result: 'hello'})).toBe('hello');
    expect(unwrapResponse({result: ''})).toBe('');
  });

  it('returns a wrapped non-string value unchanged', () => {
    expect(unwrapResponse({result: 42})).toBe(42);
    expect(unwrapResponse({result: null})).toBeNull();
    expect(unwrapResponse({result: {a: 1}})).toEqual({a: 1});
  });

  it('returns an object that is not a single-key result envelope', () => {
    expect(unwrapResponse({foo: 'bar'})).toEqual({foo: 'bar'});
    expect(unwrapResponse({result: 'x', other: 'y'})).toEqual({
      result: 'x',
      other: 'y',
    });
  });

  it('returns a non-object unchanged', () => {
    expect(unwrapResponse('hello')).toBe('hello');
    expect(unwrapResponse(42)).toBe(42);
    expect(unwrapResponse(null)).toBeNull();
    expect(unwrapResponse([1, 2])).toEqual([1, 2]);
  });
});
