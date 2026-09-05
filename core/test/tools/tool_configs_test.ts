/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ToolArgsConfig, ToolConfig} from '@google/adk';
import {
  baseToolConfigSchema,
  toolArgsConfigSchema,
  toolConfigSchema,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const myToolConfigSchema = baseToolConfigSchema.extend({
  threshold: z.number(),
  label: z.string().optional(),
  mode: z.string().default('fast'),
});

describe('baseToolConfigSchema', () => {
  it('accepts an empty object', () => {
    expect(baseToolConfigSchema.parse({})).toEqual({});
  });

  it('rejects a key it was not extended with', () => {
    const result = baseToolConfigSchema.safeParse({a: 1});

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Unrecognized key: "a"');
  });

  it.each([
    ['a string', 'x'],
    ['null', null],
    ['an array', [1, 2]],
  ])('rejects %s', (_label, value) => {
    expect(baseToolConfigSchema.safeParse(value).success).toBe(false);
  });

  it('accepts the declared keys of an extended schema', () => {
    expect(myToolConfigSchema.parse({threshold: 1, label: 'hot'})).toEqual({
      threshold: 1,
      label: 'hot',
      mode: 'fast',
    });
  });

  it('rejects an undeclared key on an extended schema', () => {
    const result = myToolConfigSchema.safeParse({threshold: 1, thresold: 2});

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      'Unrecognized key: "thresold"',
    );
  });

  it('enforces the field types of an extended schema', () => {
    expect(myToolConfigSchema.safeParse({threshold: 'no'}).success).toBe(false);
  });

  it('applies the optional and default fields of an extended schema', () => {
    expect(myToolConfigSchema.parse({threshold: 1})).toEqual({
      threshold: 1,
      mode: 'fast',
    });
  });

  it('parses to a value assignable to ToolArgsConfig', () => {
    // The assignment is the assertion: it fails at compile time if the
    // parsed shape stops being an object type.
    const args: ToolArgsConfig = myToolConfigSchema.parse({threshold: 1});

    expect(args).toEqual({threshold: 1, mode: 'fast'});
  });
});

describe('toolArgsConfigSchema', () => {
  it('keeps a key no adk-js tool declares', () => {
    expect(
      toolArgsConfigSchema.parse({somethingNobodyDeclares: 'kept'}),
    ).toEqual({somethingNobodyDeclares: 'kept'});
  });

  it('camelCases keys at every depth', () => {
    expect(
      toolArgsConfigSchema.parse({top_k: 5, nested: {max_len: 2}}),
    ).toEqual({topK: 5, nested: {maxLen: 2}});
  });

  it.each([
    ['a string', 'x'],
    ['an array', [1]],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(toolArgsConfigSchema.safeParse(value).success).toBe(false);
  });
});

describe('toolConfigSchema', () => {
  it('accepts a name on its own', () => {
    expect(toolConfigSchema.parse({name: 'google_search'})).toEqual({
      name: 'google_search',
    });
  });

  it('keeps the whole args bag and camelCases it', () => {
    expect(
      toolConfigSchema.parse({
        name: 'AgentTool',
        args: {agent: './another_agent.yaml', skip_summarization: true},
      }),
    ).toEqual({
      name: 'AgentTool',
      args: {agent: './another_agent.yaml', skipSummarization: true},
    });
  });

  it('requires a name', () => {
    expect(toolConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a name that is not a string', () => {
    expect(toolConfigSchema.safeParse({name: 1}).success).toBe(false);
  });

  it('rejects an unknown top-level key', () => {
    const result = toolConfigSchema.safeParse({
      name: 'google_search',
      argz: {},
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe('Unrecognized key: "argz"');
  });

  it('accepts args written with no value in YAML', () => {
    const config: ToolConfig = toolConfigSchema.parse({
      name: 'google_search',
      args: null,
    });

    expect(config).toEqual({name: 'google_search', args: null});
  });

  it.each([
    ['a string', 'nope'],
    ['an array', [1]],
  ])('rejects args that are %s', (_label, args) => {
    expect(toolConfigSchema.safeParse({name: 'x', args}).success).toBe(false);
  });
});
