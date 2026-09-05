/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {toolConfigSchema} from '../../src/tools/tool_configs.js';

describe('toolConfigSchema', () => {
  it('accepts a name with no args', () => {
    expect(toolConfigSchema.parse({name: './my_tools.js#searchTool'})).toEqual({
      name: './my_tools.js#searchTool',
    });
  });

  it('accepts args and keeps their keys verbatim', () => {
    const parsed = toolConfigSchema.parse({
      name: './my_tools.js#createRetriever',
      args: {'corpus_id': 'docs-prod'},
    });

    expect(parsed.args).toEqual({'corpus_id': 'docs-prod'});
  });

  it('rejects a missing name', () => {
    expect(toolConfigSchema.safeParse({args: {}}).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(toolConfigSchema.safeParse({name: ''}).success).toBe(false);
  });

  it('rejects an unknown key', () => {
    expect(
      toolConfigSchema.safeParse({name: './my_tools.js#t', arg: {}}).success,
    ).toBe(false);
  });

  it('rejects args that are not an object', () => {
    expect(
      toolConfigSchema.safeParse({name: './my_tools.js#t', args: 'nope'})
        .success,
    ).toBe(false);
    expect(
      toolConfigSchema.safeParse({name: './my_tools.js#t', args: [1, 2]})
        .success,
    ).toBe(false);
  });
});
