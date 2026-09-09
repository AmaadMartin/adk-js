/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  ExecuteBashTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ToolConfirmation,
  createSession,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

/** Quoted so the tokenizer has to handle a path containing spaces. */
const NODE = `"${process.execPath}"`;

/**
 * Multi-byte characters to stream on stdout. `€` is three UTF-8 bytes, so this
 * is roughly 1 MB and no pipe chunk boundary lands on a character boundary.
 */
const WIDE_CHAR_COUNT = 350_000;

/** The character U+FFFD, which a per-chunk decode leaves at every split. */
const REPLACEMENT_CHAR = '\uFFFD';

/** Narrows a tool result to its `stdout`, failing the test if it has none. */
function readStdout(result: unknown): string {
  if (
    typeof result === 'object' &&
    result !== null &&
    'stdout' in result &&
    typeof result.stdout === 'string'
  ) {
    return result.stdout;
  }
  return expect.fail(`expected a stdout string, got ${typeof result}`);
}

function confirmedContext(): Context {
  const session = createSession({id: 's1', appName: 'app', userId: 'u1'});
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'inv-1',
      agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
      session,
      pluginManager: new PluginManager([]),
    }),
    functionCallId: 'fc-1',
    toolConfirmation: new ToolConfirmation({confirmed: true}),
  });
}

// The tool refuses to run on Windows, so these cases cover POSIX hosts only.
describe.skipIf(process.platform === 'win32')(
  'ExecuteBashTool against a real workspace',
  () => {
    let workspace: string;

    beforeEach(async () => {
      // realpath: macOS resolves os.tmpdir() through a symlink, so the path the
      // child reports as its cwd differs from the one handed to mkdtemp.
      workspace = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'adk_bash_it_')),
      );
      await fs.writeFile(
        path.join(workspace, 'SKILL.md'),
        '# PDF Processing Guide\n',
      );
    });

    afterEach(async () => {
      await fs.rm(workspace, {recursive: true, force: true, maxRetries: 3});
    });

    it('lets one command read what an earlier command wrote', async () => {
      const tool = new ExecuteBashTool({workspace});

      const write = await tool.runAsync({
        args: {
          command: `${NODE} -e 'require("fs").writeFileSync("out.txt", "hi")'`,
        },
        toolContext: confirmedContext(),
      });
      expect(write).toMatchObject({returncode: 0});

      const read = await tool.runAsync({
        args: {command: 'cat out.txt'},
        toolContext: confirmedContext(),
      });
      expect(read).toMatchObject({stdout: 'hi', returncode: 0});

      // The relative path resolved against the workspace, not the test runner's
      // own working directory.
      expect(await fs.readFile(path.join(workspace, 'out.txt'), 'utf-8')).toBe(
        'hi',
      );
    });

    it('runs an allowed command and refuses one outside the policy', async () => {
      const tool = new ExecuteBashTool({
        workspace,
        policy: {allowedCommandPrefixes: ['cat']},
      });

      const allowed = await tool.runAsync({
        args: {command: 'cat SKILL.md'},
        toolContext: confirmedContext(),
      });
      expect(allowed).toMatchObject({returncode: 0});
      expect(allowed).toHaveProperty(
        'stdout',
        expect.stringContaining('PDF Processing Guide'),
      );

      const refused = await tool.runAsync({
        args: {command: `${NODE} -e '1'`},
        toolContext: confirmedContext(),
      });
      expect(refused).toEqual({
        error: 'Command blocked. Permitted prefixes are: cat',
      });
    });

    it('returns megabyte-scale output without corrupting a split character', async () => {
      const tool = new ExecuteBashTool({workspace});

      const result = await tool.runAsync({
        args: {
          command: `${NODE} -e 'process.stdout.write("\\u20ac".repeat(${WIDE_CHAR_COUNT}))'`,
        },
        toolContext: confirmedContext(),
      });

      expect(result).toMatchObject({returncode: 0});
      const stdout = readStdout(result);
      expect(stdout).toHaveLength(WIDE_CHAR_COUNT);
      expect(stdout).not.toContain(REPLACEMENT_CHAR);
    });
  },
);
