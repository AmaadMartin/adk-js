/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  agentRefConfigSchema,
  codeConfigSchema,
  requireExactlyOneSource,
} from '../../src/agents/common_configs.js';

/** Validates an agent reference the way the agent config schema does. */
function parseRef(raw: unknown) {
  return requireExactlyOneSource(agentRefConfigSchema.parse(raw));
}

describe('codeConfigSchema', () => {
  it('keeps the name of a valid reference', () => {
    expect(codeConfigSchema.parse({name: './my_tools.js#searchTool'})).toEqual({
      name: './my_tools.js#searchTool',
    });
  });

  it('rejects an unknown key', () => {
    expect(
      codeConfigSchema.safeParse({name: './my_tools.js#t', args: {a: 1}})
        .success,
    ).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(codeConfigSchema.safeParse({name: ''}).success).toBe(false);
  });

  it('rejects a missing name', () => {
    expect(codeConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a name that is not a string', () => {
    expect(codeConfigSchema.safeParse({name: 42}).success).toBe(false);
  });
});

describe('agentRefConfigSchema', () => {
  it('accepts a code reference', () => {
    expect(parseRef({code: './agents.js#helper'})).toEqual({
      code: './agents.js#helper',
      configPath: undefined,
    });
  });

  it('accepts a config path', () => {
    expect(parseRef({configPath: './helper.yaml'})).toEqual({
      code: undefined,
      configPath: './helper.yaml',
    });
  });

  it('accepts the config_path spelling adk-python writes', () => {
    expect(parseRef({'config_path': './helper.yaml'})).toEqual({
      code: undefined,
      configPath: './helper.yaml',
    });
  });

  it('treats an explicit null as absent', () => {
    expect(parseRef({code: './agents.js#helper', configPath: null})).toEqual({
      code: './agents.js#helper',
      configPath: undefined,
    });
  });

  it('rejects an unknown key', () => {
    expect(
      agentRefConfigSchema.safeParse({
        code: './agents.js#helper',
        name: 'helper',
      }).success,
    ).toBe(false);
  });

  it('keeps both spellings when a document writes both, and rejects it', () => {
    expect(
      agentRefConfigSchema.safeParse({
        'configPath': './a.yaml',
        'config_path': './b.yaml',
      }).success,
    ).toBe(false);
  });

  it('rejects a reference that is not an object', () => {
    expect(agentRefConfigSchema.safeParse('./helper.yaml').success).toBe(false);
    expect(
      agentRefConfigSchema.safeParse([{code: './agents.js#helper'}]).success,
    ).toBe(false);
    expect(agentRefConfigSchema.safeParse(null).success).toBe(false);
  });
});

describe('requireExactlyOneSource', () => {
  it('rejects a reference that sets both sources', () => {
    expect(() =>
      requireExactlyOneSource({
        code: './agents.js#helper',
        configPath: './h.yaml',
      }),
    ).toThrow(
      'An agent reference sets both `code` and `configPath`; exactly one of ' +
        '`code` and `configPath` must be set.',
    );
  });

  it('rejects a reference that sets neither source', () => {
    expect(() => requireExactlyOneSource({})).toThrow(
      'An agent reference sets neither `code` nor `configPath`; exactly one ' +
        'of `code` and `configPath` must be set.',
    );
  });
});
