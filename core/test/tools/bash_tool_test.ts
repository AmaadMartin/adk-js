/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {
  BashToolPolicy,
  buildResourceLimitCommands,
  ExecuteBashTool,
  isPosixPlatform,
  UNSUPPORTED_PLATFORM_ERROR,
  validateCommand,
} from '../../src/tools/bash_tool.js';
import {ToolConfirmation} from '../../src/tools/tool_confirmation.js';

describe('validateCommand', () => {
  it('rejects empty command', () => {
    const policy: BashToolPolicy = {};
    expect(validateCommand('', policy)).not.toBeNull();
    expect(validateCommand('   ', policy)).not.toBeNull();
  });

  it('default policy allows everything', () => {
    const policy: BashToolPolicy = {allowedCommandPrefixes: ['*']};
    expect(validateCommand('rm -rf /', policy)).toBeNull();
    expect(validateCommand('echo hello | grep h', policy)).toBeNull();
  });

  it('restricted policy allows prefixes', () => {
    const policy: BashToolPolicy = {allowedCommandPrefixes: ['ls', 'cat']};
    expect(validateCommand('ls -la', policy)).toBeNull();
    expect(validateCommand('cat file.txt', policy)).toBeNull();
  });

  it('restricted policy blocks others', () => {
    const policy: BashToolPolicy = {allowedCommandPrefixes: ['ls', 'cat']};
    expect(validateCommand('rm -rf .', policy)).toContain(
      'Permitted prefixes are: ls, cat',
    );
    expect(validateCommand('tree', policy)).toContain(
      'Permitted prefixes are: ls, cat',
    );
  });

  it('blocks disallowed operators', () => {
    const policy: BashToolPolicy = {
      allowedCommandPrefixes: ['*'],
      blockedOperators: ['|', ';'],
    };
    expect(validateCommand('echo hello | grep h', policy)).toBe(
      'Command contains blocked operator: |',
    );
    expect(validateCommand('ls ; rm -rf /', policy)).toBe(
      'Command contains blocked operator: ;',
    );
  });
});

describe('buildResourceLimitCommands', () => {
  it('always disables core dumps and adds nothing else for an empty policy', () => {
    expect(buildResourceLimitCommands({})).toEqual(['ulimit -c 0 2>/dev/null']);
  });

  it('converts maxMemoryBytes to KiB via ulimit -v', () => {
    // 100 MiB / 1024 = 102400 KiB (RLIMIT_AS parity).
    expect(buildResourceLimitCommands({maxMemoryBytes: 104857600})).toContain(
      'ulimit -v 102400 2>/dev/null',
    );
  });

  it('converts maxFileSizeBytes to KiB via ulimit -f', () => {
    // 50 MiB / 1024 = 51200 KiB (RLIMIT_FSIZE parity).
    expect(buildResourceLimitCommands({maxFileSizeBytes: 52428800})).toContain(
      'ulimit -f 51200 2>/dev/null',
    );
  });

  it('passes maxChildProcesses through as a raw count via ulimit -u', () => {
    expect(buildResourceLimitCommands({maxChildProcesses: 10})).toContain(
      'ulimit -u 10 2>/dev/null',
    );
  });

  it('emits fragments in order [core, memory, file, procs] when all are set', () => {
    const commands = buildResourceLimitCommands({
      maxMemoryBytes: 104857600,
      maxFileSizeBytes: 52428800,
      maxChildProcesses: 10,
    });
    expect(commands).toEqual([
      'ulimit -c 0 2>/dev/null',
      'ulimit -v 102400 2>/dev/null',
      'ulimit -f 51200 2>/dev/null',
      'ulimit -u 10 2>/dev/null',
    ]);
  });
});

describe('isPosixPlatform', () => {
  it('treats linux and darwin as POSIX', () => {
    expect(isPosixPlatform('linux')).toBe(true);
    expect(isPosixPlatform('darwin')).toBe(true);
  });

  it('treats win32 as non-POSIX', () => {
    expect(isPosixPlatform('win32')).toBe(false);
  });

  it('defaults to the current process platform', () => {
    expect(isPosixPlatform()).toBe(process.platform !== 'win32');
  });
});

describe('ExecuteBashTool', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-tool-test-'));
    fs.mkdirSync(path.join(workspace, 'pdf'));
    fs.writeFileSync(
      path.join(workspace, 'pdf', 'SKILL.md'),
      'PDF Processing Guide',
    );
  });

  afterEach(() => {
    fs.rmSync(workspace, {recursive: true, force: true});
  });

  function createMockContext(confirmed?: boolean): Context {
    const ctx = {
      actions: {skipSummarization: false},
      requestConfirmation: vi.fn(),
    } as unknown as Context;

    if (confirmed !== undefined) {
      ctx.toolConfirmation = {confirmed} as ToolConfirmation;
    }

    return ctx;
  }

  it('requests confirmation', async () => {
    const tool = new ExecuteBashTool({workspace});
    const ctx = createMockContext();
    const result = (await tool.runAsync({
      args: {command: 'ls'},
      toolContext: ctx,
    })) as Record<string, unknown>;

    expect(result.error).toContain('requires confirmation');
    expect(ctx.requestConfirmation).toHaveBeenCalledOnce();
  });

  it('rejected', async () => {
    const tool = new ExecuteBashTool({workspace});
    const ctx = createMockContext(false);
    const result = (await tool.runAsync({
      args: {command: 'ls'},
      toolContext: ctx,
    })) as Record<string, unknown>;

    expect(result.error).toBe('This tool call is rejected.');
  });

  it('executes when confirmed', async () => {
    const tool = new ExecuteBashTool({workspace});
    const ctx = createMockContext(true);
    const result = (await tool.runAsync({
      args: {command: 'ls'},
      toolContext: ctx,
    })) as Record<string, unknown>;

    expect(result.returncode).toBe(0);
    expect(result.stdout).toContain('pdf');
  });

  it('cat SKILL.md', async () => {
    const tool = new ExecuteBashTool({workspace});
    const ctx = createMockContext(true);
    const result = (await tool.runAsync({
      args: {command: 'cat pdf/SKILL.md'},
      toolContext: ctx,
    })) as Record<string, unknown>;

    expect(result.stdout).toContain('PDF Processing Guide');
  });

  it('detects errors with non-zero returncode', async () => {
    const tool = new ExecuteBashTool({workspace});
    const ctx = createMockContext(true);
    const result = (await tool.runAsync({
      args: {command: 'node -e "process.exit(42)"'},
      toolContext: ctx,
    })) as Record<string, unknown>;

    expect(result.returncode).toBe(42);
  });

  it('captures stderr', async () => {
    const tool = new ExecuteBashTool({workspace});
    const ctx = createMockContext(true);
    const result = (await tool.runAsync({
      args: {command: 'node -e "console.error(\\\'err\\\')"'},
      toolContext: ctx,
    })) as Record<string, unknown>;

    expect(result.stderr).toContain('err');
  });

  it('handles timeout', async () => {
    const policy: BashToolPolicy = {timeoutSeconds: 0.1};
    const tool = new ExecuteBashTool({workspace, policy});
    const ctx = createMockContext(true);
    const result = (await tool.runAsync({
      args: {command: 'sleep 2'},
      toolContext: ctx,
    })) as Record<string, unknown>;

    expect(result.error).toContain('timed out');
  });

  it('verifies resource limits are passed to the shell', async () => {
    const policy: BashToolPolicy = {
      maxMemoryBytes: 104857600,
      maxFileSizeBytes: 52428800,
      maxChildProcesses: 10,
    };
    const tool = new ExecuteBashTool({workspace, policy});
    const ctx = createMockContext(true);
    const result = (await tool.runAsync({
      args: {command: 'ulimit -a'},
      toolContext: ctx,
    })) as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    const stdout = result.stdout as string;
    // Memory limit (virtual memory) is passed as KiB: 104857600 / 1024 = 102400.
    expect(stdout).toContain('102400');
    // File-size limit is passed as KiB: 52428800 / 1024 = 51200.
    expect(stdout).toContain('51200');
  });

  it('disables core dumps in the spawned subprocess', async () => {
    const tool = new ExecuteBashTool({workspace});
    const ctx = createMockContext(true);
    const result = (await tool.runAsync({
      args: {command: 'ulimit -c'},
      toolContext: ctx,
    })) as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect((result.stdout as string).trim()).toBe('0');
  });

  it('applies limits best-effort: an extreme request never aborts the command or leaks ulimit errors', async () => {
    // A memory limit beyond any finite hard limit is rejected by `ulimit`; the
    // `;`-join keeps the user's command running and `2>/dev/null` keeps the
    // rejection out of captured stderr (parity with adk-python's caught,
    // logged-only failure). On hosts with unlimited hard limits the request is
    // simply accepted; either way the observable contract below must hold.
    const policy: BashToolPolicy = {maxMemoryBytes: Number.MAX_SAFE_INTEGER};
    const tool = new ExecuteBashTool({workspace, policy});
    const ctx = createMockContext(true);
    const result = (await tool.runAsync({
      args: {command: 'echo ok'},
      toolContext: ctx,
    })) as Record<string, unknown>;

    expect(result.error).toBeUndefined();
    expect(result.returncode).toBe(0);
    expect(result.stdout as string).toContain('ok');
    expect(result.stderr as string).not.toContain('ulimit');
  });

  it('empty command returns error', async () => {
    const tool = new ExecuteBashTool({workspace});
    const ctx = createMockContext(true);
    const result = (await tool.runAsync({
      args: {},
      toolContext: ctx,
    })) as Record<string, unknown>;

    expect(result.error).toContain('required');
  });
});

describe('ExecuteBashTool on non-POSIX platforms', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  function createConfirmedContext(): Context {
    return {
      actions: {skipSummarization: false},
      requestConfirmation: vi.fn(),
      toolConfirmation: {confirmed: true} as ToolConfirmation,
    } as unknown as Context;
  }

  it('returns the unsupported-platform error without spawning a process', async () => {
    const tool = new ExecuteBashTool();
    const result = (await tool.runAsync({
      args: {command: 'echo hello'},
      toolContext: createConfirmedContext(),
    })) as Record<string, unknown>;

    expect(result).toEqual({error: UNSUPPORTED_PLATFORM_ERROR});
    // No subprocess was spawned, so no execution fields are present.
    expect(result.stdout).toBeUndefined();
    expect(result.returncode).toBeUndefined();
  });
});
