/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {agentRefConfigSchema, codeConfigSchema} from '@google/adk';
import {describe, expect, it} from 'vitest';

function firstIssueMessage(result: {
  success: boolean;
  error?: {issues: Array<{message: string}>};
}): string {
  if (result.success || result.error === undefined) {
    expect.fail('expected the document to be rejected');
  }
  return result.error.issues[0].message;
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
      'Only one of `code` or `config_path` should be provided',
    );
  });

  it('rejects a reference that names no source', () => {
    const result = agentRefConfigSchema.safeParse({});

    expect(firstIssueMessage(result)).toBe(
      'Exactly one of `code` or `config_path` must be provided',
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
