/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {agentRefConfigSchema, codeConfigSchema} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {requireExactlyOneSource} from '../../src/agents/common_configs.js';

function firstIssueMessage(result: {
  success: boolean;
  error?: {issues: Array<{message: string}>};
}): string {
  if (result.success || result.error === undefined) {
    expect.fail('expected the document to be rejected');
  }
  return result.error.issues[0].message;
}

function messageOf(result: z.ZodSafeParseResult<unknown>): string {
  return result.success ? '' : z.prettifyError(result.error);
}

/** Validates an agent reference the way the agent config schema does. */
function parseRef(raw: unknown) {
  return requireExactlyOneSource(agentRefConfigSchema.parse(raw));
}

describe('codeConfigSchema', () => {
  it('accepts a name', () => {
    expect(
      codeConfigSchema.parse({name: 'my_library.my_tools.my_tool'}),
    ).toEqual({name: 'my_library.my_tools.my_tool'});
  });

  it('requires a name', () => {
    expect(codeConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an unknown key', () => {
    const result = codeConfigSchema.safeParse({name: 'my_tool', args: {a: 1}});

    expect(firstIssueMessage(result)).toContain('args');
  });
});

describe('codeConfigSchema, as a declarative code reference', () => {
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
  it.each([
    ['code', {code: 'my_library.agents.my_agent'}],
    ['config_path', {config_path: 'sub.yaml'}],
    ['configPath', {configPath: 'sub.yaml'}],
  ])('accepts %s on its own', (_name, document) => {
    expect(agentRefConfigSchema.safeParse(document).success).toBe(true);
  });

  it('leaves the source that was not given undefined', () => {
    expect(agentRefConfigSchema.parse({config_path: 'sub.yaml'})).toEqual({
      configPath: 'sub.yaml',
    });
  });

  it('rejects a reference that names both sources', () => {
    const result = agentRefConfigSchema.safeParse({
      code: 'my_library.agents.my_agent',
      config_path: 'sub.yaml',
    });

    expect(firstIssueMessage(result)).toBe(
      'Only one of `code` or `configPath` should be provided',
    );
  });

  it('rejects a reference that names no source', () => {
    const result = agentRefConfigSchema.safeParse({});

    expect(firstIssueMessage(result)).toBe(
      'Exactly one of `code` or `configPath` must be provided',
    );
  });

  it('rejects an unknown key', () => {
    const result = agentRefConfigSchema.safeParse({
      code: 'my_library.agents.my_agent',
      name: 'my_agent',
    });

    expect(firstIssueMessage(result)).toContain('name');
  });
});

describe('agentRefConfigSchema, as a sub-agent reference', () => {
  it('rejects a reference that sets both code and configPath', () => {
    const result = agentRefConfigSchema.safeParse({
      code: 'my_library.custom_agents.my_agent',
      configPath: 'search_agent.yaml',
    });

    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain(
      'Only one of `code` or `configPath` should be provided',
    );
  });

  it('rejects a reference that sets neither code nor configPath', () => {
    const result = agentRefConfigSchema.safeParse({});

    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain(
      'Exactly one of `code` or `configPath` must be provided',
    );
  });

  it('accepts a code reference and leaves configPath unset', () => {
    const ref = agentRefConfigSchema.parse({
      code: 'my_library.custom_agents.my_agent',
    });

    expect(ref).toEqual({code: 'my_library.custom_agents.my_agent'});
    expect(ref.configPath).toBeUndefined();
  });

  it('accepts a config path reference and leaves code unset', () => {
    const ref = agentRefConfigSchema.parse({configPath: 'search_agent.yaml'});

    expect(ref).toEqual({configPath: 'search_agent.yaml'});
    expect(ref.code).toBeUndefined();
  });

  it('accepts the config_path spelling and yields configPath', () => {
    const ref = agentRefConfigSchema.parse({config_path: 'search_agent.yaml'});

    expect(ref.configPath).toBe('search_agent.yaml');
  });

  it('treats a null source as not provided', () => {
    const ref = agentRefConfigSchema.parse({
      config_path: 'search_agent.yaml',
      code: null,
    });

    expect(ref.configPath).toBe('search_agent.yaml');
    expect(ref.code).toBeUndefined();
  });

  it('rejects an unknown key', () => {
    const result = agentRefConfigSchema.safeParse({
      configPath: 'search_agent.yaml',
      agent_name: 'search_agent',
    });

    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain('agentName');
  });

  it('rejects an empty code and an empty configPath', () => {
    expect(agentRefConfigSchema.safeParse({code: ''}).success).toBe(false);
    expect(agentRefConfigSchema.safeParse({configPath: ''}).success).toBe(
      false,
    );
  });
});

describe('codeConfigSchema, as a callback reference', () => {
  it('accepts a name', () => {
    expect(
      codeConfigSchema.parse({
        name: 'my_library.my_callbacks.my_callback',
      }),
    ).toEqual({name: 'my_library.my_callbacks.my_callback'});
  });

  it('rejects an unknown key', () => {
    const result = codeConfigSchema.safeParse({
      name: 'my_library.my_tools.my_tool',
      args: {limit: 3},
    });

    expect(result.success).toBe(false);
    expect(messageOf(result)).toContain('args');
  });

  it('rejects a missing name and an empty name', () => {
    expect(codeConfigSchema.safeParse({}).success).toBe(false);
    expect(codeConfigSchema.safeParse({name: ''}).success).toBe(false);
  });
});

describe('agentRefConfigSchema, as a declarative agent reference', () => {
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
