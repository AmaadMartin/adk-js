import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {
  BashToolPolicy,
  ExecuteBashTool,
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
    // Memory limit (virtual memory) is passed as kb: 104857600 / 1024 = 102400
    expect(result.stdout).toContain('102400');
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
