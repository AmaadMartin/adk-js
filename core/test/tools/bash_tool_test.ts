/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context, ExecuteBashTool, InvocationContext} from '@google/adk';
import type {ChildProcess} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  killProcessTree,
  splitCommand,
  validateCommand,
} from '../../src/tools/bash_tool.js';
import {ToolConfirmation} from '../../src/tools/tool_confirmation.js';
import {logger} from '../../src/utils/logger.js';

/** Shape of every response the tool can return, for ergonomic assertions. */
interface BashResult {
  stdout?: string;
  stderr?: string;
  returncode?: number | null;
  error?: string;
  partial?: string;
}

function createMockContext({
  functionCallId = 'fc-1',
  toolConfirmation,
}: {
  functionCallId?: string;
  toolConfirmation?: ToolConfirmation;
} = {}): Context {
  return new Context({
    invocationContext: {
      session: {state: {}},
      agent: {name: 'bash-test-agent'},
    } as unknown as InvocationContext,
    functionCallId,
    toolConfirmation,
  });
}

const confirmed = () => new ToolConfirmation({confirmed: true});
const rejected = () => new ToolConfirmation({confirmed: false});

/** Builds a portable `node -e "<script>"` command (node is always present). */
const nodeCommand = (script: string) => `node -e "${script}"`;

describe('validateCommand', () => {
  it('rejects empty and whitespace-only commands', () => {
    expect(validateCommand('', {})).toBe('Command is required.');
    expect(validateCommand('   ', {})).toBe('Command is required.');
  });

  it('allows everything under the default policy', () => {
    expect(validateCommand('rm -rf /', {})).toBeUndefined();
    expect(validateCommand('cat /etc/passwd', {})).toBeUndefined();
    expect(validateCommand('echo hello | grep h', {})).toBeUndefined();
    expect(validateCommand('ls ; rm -rf /', {})).toBeUndefined();
  });

  it('allows commands matching a restricted prefix list', () => {
    const policy = {allowedCommandPrefixes: ['ls', 'cat']};
    expect(validateCommand('ls -la', policy)).toBeUndefined();
    expect(validateCommand('cat file.txt', policy)).toBeUndefined();
  });

  it('blocks commands outside the restricted prefix list', () => {
    const policy = {allowedCommandPrefixes: ['ls', 'cat']};
    expect(validateCommand('tree', policy)).toContain(
      'Permitted prefixes are: ls, cat',
    );
    expect(validateCommand('rm -rf .', policy)).toContain(
      'Permitted prefixes are: ls, cat',
    );
  });

  it('enforces blocked operators even under the wildcard allowlist', () => {
    const policy = {
      allowedCommandPrefixes: ['*'],
      blockedOperators: ['|', ';', '&&'],
    };
    expect(validateCommand('echo hello | grep h', policy)).toBe(
      'Command contains blocked operator: |',
    );
    expect(validateCommand('ls ; rm -rf /', policy)).toBe(
      'Command contains blocked operator: ;',
    );
  });
});

describe('splitCommand', () => {
  it('splits on unquoted whitespace and collapses runs of spaces', () => {
    expect(splitCommand('echo hello')).toEqual(['echo', 'hello']);
    expect(splitCommand('  echo   hello  ')).toEqual(['echo', 'hello']);
    expect(splitCommand('')).toEqual([]);
  });

  it('keeps double-quoted content together with backslash escapes', () => {
    expect(splitCommand('cat "a b.txt"')).toEqual(['cat', 'a b.txt']);
    expect(splitCommand('echo "a\\"b"')).toEqual(['echo', 'a"b']);
  });

  it('keeps single-quoted content literal', () => {
    expect(splitCommand("cat 'a b.txt'")).toEqual(['cat', 'a b.txt']);
  });

  it('honors backslash escapes outside quotes', () => {
    expect(splitCommand('cat a\\ b.txt')).toEqual(['cat', 'a b.txt']);
    expect(splitCommand('a\\')).toEqual(['a']);
  });

  it('treats shell operators as literal tokens', () => {
    expect(splitCommand('echo a | b')).toEqual(['echo', 'a', '|', 'b']);
  });
});

describe('killProcessTree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fakeChild = (pid: number | undefined, kill: () => boolean) => ({
    pid,
    kill: kill as unknown as ChildProcess['kill'],
  });

  it('does nothing when the child has no pid', () => {
    const killSpy = vi.spyOn(process, 'kill');
    const childKill = vi.fn();
    killProcessTree(fakeChild(undefined, childKill));
    expect(killSpy).not.toHaveBeenCalled();
    expect(childKill).not.toHaveBeenCalled();
  });

  it('kills the whole process group via a negative pid', () => {
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    const childKill = vi.fn(() => true);
    killProcessTree(fakeChild(4242, childKill));
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(childKill).not.toHaveBeenCalled();
  });

  it('falls back to killing the child when the group kill fails', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('no such group');
    });
    const childKill = vi.fn(() => true);
    killProcessTree(fakeChild(4242, childKill));
    expect(childKill).toHaveBeenCalledWith('SIGKILL');
  });

  it('swallows errors when the child is already gone', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('no such group');
    });
    const childKill = vi.fn(() => {
      throw new Error('already dead');
    });
    expect(() => killProcessTree(fakeChild(4242, childKill))).not.toThrow();
  });
});

describe('ExecuteBashTool', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'bash-tool-')),
    );
  });

  afterEach(async () => {
    await fs.rm(workspace, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  describe('declaration', () => {
    it('declares execute_bash with a required command parameter', () => {
      const declaration = new ExecuteBashTool()._getDeclaration();
      expect(declaration.name).toBe('execute_bash');
      expect(declaration.parameters?.required).toEqual(['command']);
      expect(declaration.parameters?.properties?.['command'].type).toBe(
        'STRING',
      );
    });
  });

  describe('confirmation flow', () => {
    it('requests confirmation and does not spawn on the first call', async () => {
      const tool = new ExecuteBashTool({workspace});
      const ctx = createMockContext({functionCallId: 'fc-confirm'});

      const result = (await tool.runAsync({
        args: {command: 'ls'},
        toolContext: ctx,
      })) as BashResult;

      expect(result.partial).toBeDefined();
      expect(result.stdout).toBeUndefined();
      expect(result.returncode).toBeUndefined();
      expect(ctx.actions.skipSummarization).toBe(true);
      const confirmation = ctx.actions.requestedToolConfirmations['fc-confirm'];
      expect(confirmation).toBeDefined();
      expect(confirmation.hint).toContain('ls');
    });

    it('rejects the call when confirmation is denied', async () => {
      const tool = new ExecuteBashTool({workspace});
      const result = (await tool.runAsync({
        args: {command: 'ls'},
        toolContext: createMockContext({toolConfirmation: rejected()}),
      })) as BashResult;

      expect(result).toEqual({error: 'This tool call is rejected.'});
    });
  });

  describe('validation', () => {
    it('rejects a disallowed command without requesting confirmation', async () => {
      const tool = new ExecuteBashTool({
        workspace,
        policy: {allowedCommandPrefixes: ['ls']},
      });
      const ctx = createMockContext({functionCallId: 'fc-blocked'});

      const result = (await tool.runAsync({
        args: {command: 'rm -rf .'},
        toolContext: ctx,
      })) as BashResult;

      expect(result.error).toContain('Permitted prefixes are: ls');
      expect(Object.keys(ctx.actions.requestedToolConfirmations)).toHaveLength(
        0,
      );
    });

    it('rejects a missing command argument', async () => {
      const tool = new ExecuteBashTool({workspace});
      const result = (await tool.runAsync({
        args: {},
        toolContext: createMockContext({toolConfirmation: confirmed()}),
      })) as BashResult;

      expect(result.error?.toLowerCase()).toContain('required');
    });
  });

  describe('execution', () => {
    it('runs an allowed, confirmed command and captures stdout', async () => {
      const tool = new ExecuteBashTool({workspace});
      const result = (await tool.runAsync({
        args: {command: nodeCommand("console.log('hi')")},
        toolContext: createMockContext({toolConfirmation: confirmed()}),
      })) as BashResult;

      expect(result.returncode).toBe(0);
      expect(result.stdout).toContain('hi');
      expect(result.stderr).toBe('<no stderr captured>');
    });

    it('reads a file from the workspace end-to-end', async () => {
      await fs.writeFile(
        path.join(workspace, 'note.txt'),
        'workspace file contents',
      );
      const tool = new ExecuteBashTool({workspace});
      const result = (await tool.runAsync({
        args: {
          command: nodeCommand(
            "process.stdout.write(require('fs').readFileSync('note.txt','utf8'))",
          ),
        },
        toolContext: createMockContext({toolConfirmation: confirmed()}),
      })) as BashResult;

      expect(result.returncode).toBe(0);
      expect(result.stdout).toBe('workspace file contents');
    });

    it('captures stderr', async () => {
      const tool = new ExecuteBashTool({workspace});
      const result = (await tool.runAsync({
        args: {command: nodeCommand("process.stderr.write('err')")},
        toolContext: createMockContext({toolConfirmation: confirmed()}),
      })) as BashResult;

      expect(result.stderr).toContain('err');
      expect(result.stdout).toBe('<no stdout captured>');
    });

    it('reports a non-zero return code', async () => {
      const tool = new ExecuteBashTool({workspace});
      const result = (await tool.runAsync({
        args: {command: nodeCommand('process.exit(42)')},
        toolContext: createMockContext({toolConfirmation: confirmed()}),
      })) as BashResult;

      expect(result.returncode).toBe(42);
    });

    it('runs the command in the configured workspace', async () => {
      const tool = new ExecuteBashTool({workspace});
      const result = (await tool.runAsync({
        args: {command: nodeCommand('process.stdout.write(process.cwd())')},
        toolContext: createMockContext({toolConfirmation: confirmed()}),
      })) as BashResult;

      expect(result.stdout).toBe(workspace);
    });

    it('kills the process and reports a timeout', async () => {
      const tool = new ExecuteBashTool({
        workspace,
        policy: {timeoutSeconds: 0.2},
      });
      const result = (await tool.runAsync({
        args: {command: nodeCommand('setTimeout(() => {}, 100000)')},
        toolContext: createMockContext({toolConfirmation: confirmed()}),
      })) as BashResult;

      expect(result.error?.toLowerCase()).toContain('timed out');
    });

    it('returns an error when the program cannot be spawned', async () => {
      const tool = new ExecuteBashTool({workspace});
      const result = (await tool.runAsync({
        args: {command: 'this-binary-does-not-exist-xyz --flag'},
        toolContext: createMockContext({toolConfirmation: confirmed()}),
      })) as BashResult;

      expect(result.error).toContain('Execution failed');
    });

    it('returns an error when spawn throws synchronously', async () => {
      const tool = new ExecuteBashTool({workspace});
      const result = (await tool.runAsync({
        args: {command: 'bad\u0000command'},
        toolContext: createMockContext({toolConfirmation: confirmed()}),
      })) as BashResult;

      expect(result.error).toContain('Execution failed');
      expect(result.stdout).toBe('<no stdout captured>');
    });
  });

  describe('resource-limit fields (carried but not enforced)', () => {
    it('warns when rlimit fields are set and still executes normally', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const tool = new ExecuteBashTool({
        workspace,
        policy: {maxFileSizeBytes: 50 * 1024 * 1024, maxChildProcesses: 10},
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('not enforced'),
      );

      const result = (await tool.runAsync({
        args: {command: nodeCommand("console.log('ok')")},
        toolContext: createMockContext({toolConfirmation: confirmed()}),
      })) as BashResult;

      expect(result.returncode).toBe(0);
      expect(result.stdout).toContain('ok');
    });

    it('does not warn when no rlimit fields are set', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      new ExecuteBashTool({workspace, policy: {timeoutSeconds: 5}});
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('not enforced'),
      );
    });
  });
});
