/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {agentRefConfigSchema, codeConfigSchema} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

function messageOf(result: z.ZodSafeParseResult<unknown>): string {
  return result.success ? '' : z.prettifyError(result.error);
}

describe('agentRefConfigSchema', () => {
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

describe('codeConfigSchema', () => {
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
