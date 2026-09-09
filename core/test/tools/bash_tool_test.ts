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
import {
  ResolvedBashToolPolicy,
  validateCommand,
} from '../../src/tools/bash_tool.js';

/** Quoted so the tokenizer has to handle a path containing spaces. */
const NODE = `"${process.execPath}"`;

/** Spawning a child process is slow on a loaded CI runner. */
const SPAWN_TIMEOUT_MS = 30_000;

/** How long the timeout test's command tree runs if nothing kills it. */
const SURVIVOR_LIFETIME_MS = 10_000;

/** Upper bound on a timed-out call: comfortably short of the command itself. */
const TIMED_OUT_BY_MS = 5_000;

/** Long enough that a timeout resolved to a near-zero delay fires first. */
const OUTLIVES_MS = 500;

function makePolicy(
  overrides: Partial<ResolvedBashToolPolicy> = {},
): ResolvedBashToolPolicy {
  return {
    allowedCommandPrefixes: ['*'],
    blockedOperators: [],
    timeoutSeconds: 30,
    ...overrides,
  };
}

function makeContext(toolConfirmation?: ToolConfirmation): Context {
  const session = createSession({id: 's1', appName: 'app', userId: 'u1'});
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    // A real agent instance, so the fixture breaks if InvocationContext's
    // contract changes (rather than being silenced by a cast).
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({
    invocationContext,
    functionCallId: 'fc-1',
    toolConfirmation,
  });
}

const confirmedContext = () =>
  makeContext(new ToolConfirmation({confirmed: true}));
const rejectedContext = () =>
  makeContext(new ToolConfirmation({confirmed: false}));

describe('validateCommand', () => {
  it('rejects an empty or blank command', () => {
    expect(validateCommand('', makePolicy())).toBe('Command is required.');
    expect(validateCommand('   ', makePolicy())).toBe('Command is required.');
  });

  it('allows everything under the default policy', () => {
    for (const command of [
      'rm -rf /',
      'cat /etc/passwd',
      'sudo curl',
      'echo hello | grep h',
      'ls ; rm -rf /',
    ]) {
      expect(validateCommand(command, makePolicy())).toBeUndefined();
    }
  });

  it('allows a command matching a permitted prefix', () => {
    const policy = makePolicy({allowedCommandPrefixes: ['ls', 'cat']});
    expect(validateCommand('ls -la', policy)).toBeUndefined();
    expect(validateCommand('cat file.txt', policy)).toBeUndefined();
  });

  it('blocks a command matching no permitted prefix', () => {
    const policy = makePolicy({allowedCommandPrefixes: ['ls', 'cat']});
    expect(validateCommand('rm -rf .', policy)).toBe(
      'Command blocked. Permitted prefixes are: ls, cat',
    );
    expect(validateCommand('tree', policy)).toBe(
      'Command blocked. Permitted prefixes are: ls, cat',
    );
  });

  it('reports a blocked operator even under the allow-any policy', () => {
    const policy = makePolicy({
      blockedOperators: ['|', ';', '$(', '`', '&&', '||'],
    });
    expect(validateCommand('echo hello | grep h', policy)).toBe(
      'Command contains blocked operator: |',
    );
    expect(validateCommand('ls ; rm -rf /', policy)).toBe(
      'Command contains blocked operator: ;',
    );
  });

  it('refuses an argument a prefix allowlist cannot exclude', () => {
    // A prefix matches the start of the command, so 'git' alone cannot say
    // "but never push --force". The denylist is what reads the arguments.
    const policy = makePolicy({
      allowedCommandPrefixes: ['git'],
      blockedOperators: ['--force'],
    });
    expect(validateCommand('git status', policy)).toBeUndefined();
    expect(validateCommand('git push --force', policy)).toBe(
      'Command contains blocked operator: --force',
    );
  });
});

/** The clause every description carries, stating that no shell runs. */
const NO_SHELL_NOTE =
  'All commands require user confirmation. No shell runs the command, so ' +
  '`|`, `;`, `&&`, `$()`, redirection and globs are passed to the program ' +
  'as literal arguments instead of being interpreted.';

describe('ExecuteBashTool declaration', () => {
  it('declares a required command string named execute_bash', () => {
    const tool = new ExecuteBashTool();
    expect(tool._getDeclaration()).toEqual({
      name: 'execute_bash',
      description: tool.description,
      parameters: {
        type: 'OBJECT',
        properties: {
          command: {
            type: 'STRING',
            description:
              'The command to execute, as a program and its arguments. ' +
              'Quoting follows POSIX shell rules, but no shell interprets ' +
              'the result, so it cannot pipe, redirect or chain.',
          },
        },
        required: ['command'],
      },
    });
  });

  it('describes the default policy as allowing any command', () => {
    expect(new ExecuteBashTool().description).toBe(
      `Executes a command with the working directory set to the workspace. ${'Allowed: any command. '}${NO_SHELL_NOTE}`,
    );
  });

  it('defaults every policy field an explicit undefined leaves open', () => {
    const tool = new ExecuteBashTool({
      policy: {
        allowedCommandPrefixes: undefined,
        blockedOperators: undefined,
        timeoutSeconds: undefined,
      },
    });
    expect(tool.description).toBe(
      `Executes a command with the working directory set to the workspace. ${'Allowed: any command. '}${NO_SHELL_NOTE}`,
    );
  });

  it('describes a restricted policy by listing its prefixes', () => {
    const tool = new ExecuteBashTool({
      policy: {allowedCommandPrefixes: ['ls', 'cat']},
    });
    expect(tool.description).toBe(
      `Executes a command with the working directory set to the workspace. ${'Allowed: commands matching prefixes: ls, cat. '}${NO_SHELL_NOTE}`,
    );
  });

  it('always requires confirmation', async () => {
    await expect(
      new ExecuteBashTool().checkRequireConfirmation(),
    ).resolves.toBe(true);
  });
});

describe('ExecuteBashTool on a non-POSIX host', () => {
  it('refuses a confirmed command', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (descriptor === undefined) {
      expect.fail('process.platform has no property descriptor');
    }
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
    try {
      const result = await new ExecuteBashTool().runAsync({
        args: {command: 'echo hello'},
        toolContext: confirmedContext(),
      });
      expect(result).toEqual({
        error: 'ExecuteBashTool is only supported on POSIX systems.',
      });
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });
});

describe.skipIf(process.platform === 'win32')('ExecuteBashTool', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-bash-tool-test-'));
    // Mirrors the Python fixture's layout, with the scripts written in
    // JavaScript so the test can run them with the Node binary under test.
    const skillDir = path.join(workspace, 'pdf');
    await fs.mkdir(path.join(skillDir, 'scripts'), {recursive: true});
    await fs.mkdir(path.join(skillDir, 'references'), {recursive: true});
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: pdf\n---\n# PDF Processing Guide\n',
    );
    await fs.writeFile(
      path.join(skillDir, 'scripts', 'extract_form_structure.js'),
      'console.log(`extracting from ${process.argv[2]}`);\n',
    );
    await fs.writeFile(
      path.join(skillDir, 'references', 'REFERENCE.md'),
      '# Reference\n',
    );
    await fs.writeFile(path.join(workspace, 'sample.pdf'), '%PDF-1.4 fake');
    await fs.writeFile(
      path.join(workspace, 'spawner.cjs'),
      "require('node:child_process').spawn(process.execPath, " +
        `['-e', 'setTimeout(() => {}, ${SURVIVOR_LIFETIME_MS})'], ` +
        "{stdio: 'inherit'});\n" +
        `setTimeout(() => {}, ${SURVIVOR_LIFETIME_MS});\n`,
    );
    // Same idea, but `detached` puts the grandchild in its own process group,
    // where the tool's group kill cannot reach it. `unref` lets this script
    // exit at once, leaving only the escapee holding the pipes.
    await fs.writeFile(
      path.join(workspace, 'escaper.cjs'),
      "require('node:child_process').spawn(process.execPath, " +
        `['-e', 'setTimeout(() => {}, ${SURVIVOR_LIFETIME_MS})'], ` +
        "{stdio: 'inherit', detached: true}).unref();\n",
    );
  });

  afterEach(async () => {
    // A command killed by the timeout test can outlive the test, and it holds
    // the workspace as its cwd until it exits; retry until it is gone.
    await fs.rm(workspace, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  }, SPAWN_TIMEOUT_MS);

  it('requests confirmation on the first call', async () => {
    const ctx = makeContext();
    const tool = new ExecuteBashTool({workspace});

    const result = await tool.runAsync({
      args: {command: 'ls'},
      toolContext: ctx,
    });

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(ctx.actions.requestedToolConfirmations['fc-1']?.hint).toBe(
      'Please approve or reject the bash command: ls',
    );
    expect(ctx.actions.skipSummarization).toBe(true);
  });

  it('refuses a rejected call', async () => {
    const tool = new ExecuteBashTool({workspace});
    const result = await tool.runAsync({
      args: {command: 'ls'},
      toolContext: rejectedContext(),
    });
    expect(result).toEqual({error: 'This tool call is rejected.'});
  });

  it('runs the command once it is confirmed', async () => {
    const tool = new ExecuteBashTool({workspace});
    const result = await tool.runAsync({
      args: {command: 'ls'},
      toolContext: confirmedContext(),
    });
    expect(result).toMatchObject({returncode: 0});
    expect(result).toHaveProperty('stdout', expect.stringContaining('pdf'));
  });

  it('reads a file from the workspace', async () => {
    const tool = new ExecuteBashTool({workspace});
    const result = await tool.runAsync({
      args: {command: 'cat pdf/SKILL.md'},
      toolContext: confirmedContext(),
    });
    expect(result).toHaveProperty(
      'stdout',
      expect.stringContaining('PDF Processing Guide'),
    );
  });

  it('runs a script stored in the workspace', async () => {
    const tool = new ExecuteBashTool({workspace});
    const result = await tool.runAsync({
      args: {
        command: `${NODE} pdf/scripts/extract_form_structure.js test.pdf`,
      },
      toolContext: confirmedContext(),
    });
    expect(result).toMatchObject({returncode: 0});
    expect(result).toHaveProperty(
      'stdout',
      expect.stringContaining('extracting from test.pdf'),
    );
  });

  it('blocks a disallowed command before asking for confirmation', async () => {
    const ctx = makeContext();
    const tool = new ExecuteBashTool({
      workspace,
      policy: {allowedCommandPrefixes: ['ls']},
    });

    const result = await tool.runAsync({
      args: {command: 'rm -rf .'},
      toolContext: ctx,
    });

    expect(result).toEqual({
      error: 'Command blocked. Permitted prefixes are: ls',
    });
    expect(ctx.actions.requestedToolConfirmations).toEqual({});
  });

  it('captures stderr', async () => {
    const tool = new ExecuteBashTool({workspace});
    const result = await tool.runAsync({
      args: {command: `${NODE} -e "process.stderr.write('err')"`},
      toolContext: confirmedContext(),
    });
    expect(result).toHaveProperty('stderr', expect.stringContaining('err'));
  });

  it('reports a non-zero exit status', async () => {
    const tool = new ExecuteBashTool({workspace});
    const result = await tool.runAsync({
      args: {command: `${NODE} -e "process.exit(42)"`},
      toolContext: confirmedContext(),
    });
    expect(result).toMatchObject({returncode: 42});
  });

  it(
    'kills the whole process group when the command runs past the timeout',
    async () => {
      const tool = new ExecuteBashTool({
        workspace,
        policy: {timeoutSeconds: 1},
      });
      const started = Date.now();

      // `spawner.cjs` forks a grandchild that inherits the pipes. Killing only
      // the spawned process leaves that grandchild holding stdout open, so the
      // call would return no earlier than SURVIVOR_LIFETIME_MS.
      const result = await tool.runAsync({
        args: {command: `${NODE} spawner.cjs`},
        toolContext: confirmedContext(),
      });

      expect(result).toMatchObject({
        error: 'Command timed out after 1 seconds.',
        returncode: -9,
      });
      expect(Date.now() - started).toBeLessThan(TIMED_OUT_BY_MS);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'times out even when a command leaves the process group holding the pipes',
    async () => {
      const tool = new ExecuteBashTool({
        workspace,
        policy: {timeoutSeconds: 1},
      });
      const started = Date.now();

      // `escaper.cjs` puts its grandchild in a new process group, so the group
      // kill cannot reach it, and the grandchild holds stdout open. Only
      // releasing the read ends bounds the call; awaiting 'close' alone would
      // last SURVIVOR_LIFETIME_MS.
      const result = await tool.runAsync({
        args: {command: `${NODE} escaper.cjs`},
        toolContext: confirmedContext(),
      });

      expect(result).toMatchObject({
        error: 'Command timed out after 1 seconds.',
      });
      expect(Date.now() - started).toBeLessThan(TIMED_OUT_BY_MS);
    },
    SPAWN_TIMEOUT_MS,
  );

  it('runs without a timeout when the policy disables it', async () => {
    const tool = new ExecuteBashTool({
      workspace,
      policy: {timeoutSeconds: null},
    });
    const result = await tool.runAsync({
      args: {command: 'ls'},
      toolContext: confirmedContext(),
    });
    expect(result).toMatchObject({returncode: 0});
  });

  it('applies the default timeout when the policy passes undefined', async () => {
    const tool = new ExecuteBashTool({
      workspace,
      policy: {timeoutSeconds: undefined},
    });
    // Outlives any near-zero timeout, so a default that resolves to `undefined`
    // kills the command instead of letting it finish.
    const result = await tool.runAsync({
      args: {command: `${NODE} -e "setTimeout(() => {}, ${OUTLIVES_MS})"`},
      toolContext: confirmedContext(),
    });
    expect(result).toMatchObject({returncode: 0});
  });

  it('runs the command with the workspace as its working directory', async () => {
    const tool = new ExecuteBashTool({workspace});
    const result = await tool.runAsync({
      args: {command: `${NODE} -e "console.log(process.cwd())"`},
      toolContext: confirmedContext(),
    });
    // macOS resolves the mkdtemp path through a symlink, so compare realpaths.
    expect(result).toHaveProperty(
      'stdout',
      `${await fs.realpath(workspace)}\n`,
    );
  });

  it('rejects a missing or empty command', async () => {
    const tool = new ExecuteBashTool({workspace});
    const ctx = confirmedContext();
    await expect(tool.runAsync({args: {}, toolContext: ctx})).resolves.toEqual({
      error: 'Command is required.',
    });
    await expect(
      tool.runAsync({args: {command: ''}, toolContext: ctx}),
    ).resolves.toEqual({error: 'Command is required.'});
  });

  it('reports an empty capture with a placeholder', async () => {
    const tool = new ExecuteBashTool({workspace});
    const result = await tool.runAsync({
      args: {command: 'true'},
      toolContext: confirmedContext(),
    });
    expect(result).toEqual({
      stdout: '<no stdout captured>',
      stderr: '<no stderr captured>',
      returncode: 0,
    });
  });

  it('reports a spawn failure without a return code', async () => {
    const tool = new ExecuteBashTool({workspace});
    const result = await tool.runAsync({
      args: {command: 'definitely-not-a-real-binary-xyz'},
      toolContext: confirmedContext(),
    });
    expect(result).toMatchObject({
      stdout: '<no stdout captured>',
      stderr: '<no stderr captured>',
    });
    expect(result).toHaveProperty(
      'error',
      expect.stringContaining('Execution failed:'),
    );
    expect(result).not.toHaveProperty('returncode');
  });

  it('reports a tokenizer failure', async () => {
    const tool = new ExecuteBashTool({workspace});
    const result = await tool.runAsync({
      args: {command: 'echo "unterminated'},
      toolContext: confirmedContext(),
    });
    expect(result).toEqual({
      error: 'Execution failed: No closing quotation',
      stdout: '<no stdout captured>',
      stderr: '<no stderr captured>',
    });
  });
});
