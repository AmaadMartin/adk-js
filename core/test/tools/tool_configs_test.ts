/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {toolArgsConfigSchema, toolConfigSchema} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('toolConfigSchema', () => {
  it('accepts a name on its own', () => {
    expect(toolConfigSchema.parse({name: 'google_search'})).toEqual({
      name: 'google_search',
    });
  });

  it('keeps the whole args bag', () => {
    expect(
      toolConfigSchema.parse({
        name: 'my_package.my_module.make_tool',
        args: {a: 1, b: 'x'},
      }),
    ).toEqual({name: 'my_package.my_module.make_tool', args: {a: 1, b: 'x'}});
  });

  it('requires a name', () => {
    expect(toolConfigSchema.safeParse({args: {a: 1}}).success).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    expect(
      toolConfigSchema.safeParse({name: 'google_search', argz: {a: 1}}).success,
    ).toBe(false);
  });
});

describe('toolArgsConfigSchema', () => {
  it('camelCases the keys of the bag, at every depth', () => {
    expect(
      toolArgsConfigSchema.parse({top_k: 5, nested: {max_len: 2}}),
    ).toEqual({
      topK: 5,
      nested: {maxLen: 2},
    });
  });
});
