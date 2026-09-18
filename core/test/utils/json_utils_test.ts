/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {stringifyForLog} from '../../src/utils/json_utils.js';

describe('stringifyForLog', () => {
  it('serializes an ordinary value as JSON', () => {
    expect(stringifyForLog({query: 'test'})).toBe('{"query":"test"}');
  });

  it('serializes a BigInt as its decimal string', () => {
    expect(stringifyForLog({id: 1n})).toBe('{"id":"1"}');
    expect(stringifyForLog({page: {ids: [1n, 2n]}})).toBe(
      '{"page":{"ids":["1","2"]}}',
    );
  });

  it('replaces a repeated object reference with [Circular]', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(stringifyForLog(cyclic)).toBe('{"self":"[Circular]"}');
  });

  it('keeps a Date as its ISO string, because toJSON runs first', () => {
    expect(stringifyForLog(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
  });

  it('falls back to String when the value serializes to nothing', () => {
    expect(stringifyForLog({toJSON: () => undefined})).toBe('[object Object]');
    expect(stringifyForLog(undefined)).toBe('undefined');
  });

  it('falls back to String when a getter throws', () => {
    const hostile = {
      get boom(): string {
        throw new Error('getter failed');
      },
    };

    expect(stringifyForLog(hostile)).toBe('[object Object]');
  });

  it('serializes null and a primitive', () => {
    expect(stringifyForLog(null)).toBe('null');
    expect(stringifyForLog(42)).toBe('42');
  });
});
