/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression test for the agent name `adk create` accepts.
 *
 * The scaffolder used to write the project first and let the bad name surface
 * later, so `adk create 123app` produced a directory that `App` refuses to
 * load and that `npm install` cannot install. The filesystem stays real here:
 * "nothing was written" is the assertion, so it has to be checked against the
 * real filesystem rather than against a mocked `createFolder`.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

const MODEL = 'gemini-2.5-flash';

// `cli_create` resolves paths against `process.cwd()`, so the working
// directory has to be set before it is imported.
let createAgent: typeof import('../../src/cli/cli_create.js').createAgent;
let workDir: string;
let originalCwd: string;

// `createAgent` shells out to `npm install` once the files are written.
vi.mock('node:child_process', () => ({
  exec: vi.fn(
    (
      _cmd: string,
      _opts: unknown,
      callback?: (e: null, stdout: string, stderr: string) => void,
    ) => {
      callback?.(null, '', '');
      return {on: (event: string, cb: () => void) => event === 'exit' && cb()};
    },
  ),
  execSync: vi.fn(() => ''),
  spawn: vi.fn(),
}));

function creationOptions(agentName: string) {
  return {
    agentName,
    forceYes: true,
    model: MODEL,
    language: 'ts',
    apiKey: 'test-api-key',
    project: '',
    region: '',
  };
}

describe('adk create: agent name validation', () => {
  beforeAll(async () => {
    originalCwd = process.cwd();
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-create-validate-'));
    process.chdir(workDir);
    ({createAgent} = await import('../../src/cli/cli_create.js'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(workDir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  it('scaffolds a project for a valid name', async () => {
    await createAgent(creationOptions('my-agent'));

    const generated = await fs.readdir(path.join(workDir, 'my-agent'));
    expect(generated.sort()).toEqual([
      '.env',
      'agent.ts',
      'package.json',
      'tsconfig.json',
    ]);
  });

  it.each([
    {
      name: 'rejects a name that starts with a digit',
      agentName: '123app',
      message: /Invalid app name '123app'/,
    },
    {
      name: 'rejects a name that contains a space',
      agentName: 'my app',
      message: /Invalid app name 'my app'/,
    },
    {
      name: "rejects the reserved name 'user'",
      agentName: 'user',
      message: /reserved for end-user input/,
    },
    {
      name: 'rejects the last path segment of a path-shaped name',
      agentName: 'nested/123app',
      message: /Invalid app name '123app'/,
    },
    {
      name: 'rejects the current directory rather than adopting its name',
      agentName: '.',
      message: /Invalid app name '\.'/,
    },
  ])('$name', async ({agentName, message}) => {
    const before = (await fs.readdir(workDir)).sort();

    await expect(createAgent(creationOptions(agentName))).rejects.toThrow(
      message,
    );

    expect((await fs.readdir(workDir)).sort()).toEqual(before);
  });
});
