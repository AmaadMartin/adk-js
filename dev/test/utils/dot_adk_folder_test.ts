/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

import {dotAdkDir, resolveAgentDir} from '../../src/utils/dot_adk_folder.js';

const AGENTS_ROOT = path.resolve(path.join('base', 'agents'));

describe('dotAdkDir', () => {
  it('puts the .adk folder inside the agent directory', () => {
    const agentDir = path.join(AGENTS_ROOT, 'weather_agent');

    expect(dotAdkDir(agentDir)).toBe(path.join(agentDir, '.adk'));
  });
});

describe('resolveAgentDir', () => {
  it('resolves an app name to a directory under the agents root', () => {
    expect(
      resolveAgentDir({agentsRoot: AGENTS_ROOT, appName: 'valid_agent'}),
    ).toBe(path.join(AGENTS_ROOT, 'valid_agent'));
  });

  it('resolves against a relative agents root', () => {
    expect(
      resolveAgentDir({
        agentsRoot: path.join('base', 'agents'),
        appName: 'valid_agent',
      }),
    ).toBe(path.join(AGENTS_ROOT, 'valid_agent'));
  });

  // adk-js app names are flat, so `my.agent.ts` yields the app name
  // `my.agent`. Rewriting the dot to a separator, as adk-python does for its
  // dotted module names, would scatter this agent's data over two directories.
  it('keeps a dot in an app name literal', () => {
    expect(
      resolveAgentDir({agentsRoot: AGENTS_ROOT, appName: 'my.agent'}),
    ).toBe(path.join(AGENTS_ROOT, 'my.agent'));
  });

  it.each([
    ['a parent traversal', '../escape_attempt'],
    // `<root>/../agents_evil` shares a string prefix with `<root>`, so a
    // `startsWith` containment check would let it through.
    ['a prefix sibling', '../agents_evil'],
    ['the parent itself', '..'],
    ['the root itself', '.'],
    ['an empty name', ''],
    ['a nested name', 'a/b'],
    ['a backslash-separated name', 'a\\b'],
    ['an absolute path', path.resolve(path.join('etc', 'passwd'))],
  ])('rejects %s', (_description, appName) => {
    expect(() => resolveAgentDir({agentsRoot: AGENTS_ROOT, appName})).toThrow(
      /Invalid app name/,
    );
  });

  it('keeps the resolved path out of the error message', () => {
    expect(() =>
      resolveAgentDir({agentsRoot: AGENTS_ROOT, appName: '../escape_attempt'}),
    ).toThrow(
      "Invalid app name '../escape_attempt': resolves outside the agents directory",
    );
  });
});
