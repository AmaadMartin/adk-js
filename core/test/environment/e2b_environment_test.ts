/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {E2BEnvironment} from '@google/adk';
import {
  CommandExitError,
  FileNotFoundError,
  TimeoutError,
  type CommandResult,
  type CommandStartOpts,
  type SandboxOpts,
} from 'e2b';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

const SANDBOX_HOME = '/home/user';

const {createMock} = vi.hoisted(() => ({
  createMock: vi.fn<(opts: SandboxOpts) => Promise<unknown>>(),
}));

vi.mock('e2b', async (importOriginal) => ({
  ...(await importOriginal<typeof import('e2b')>()),
  Sandbox: {create: createMock},
}));

/** Builds a fake sandbox exposing only the surface the environment uses. */
function makeSandbox(running = true) {
  return {
    isRunning: vi.fn<() => Promise<boolean>>().mockResolvedValue(running),
    setTimeout: vi
      .fn<(timeoutMs: number) => Promise<void>>()
      .mockResolvedValue(undefined),
    kill: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    commands: {
      run: vi.fn<
        (command: string, opts: CommandStartOpts) => Promise<CommandResult>
      >(),
    },
    files: {
      read: vi.fn<
        (filePath: string, opts: {format: 'bytes'}) => Promise<Uint8Array>
      >(),
      write: vi
        .fn<(filePath: string, data: string | Blob) => Promise<void>>()
        .mockResolvedValue(undefined),
    },
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('E2BEnvironment', () => {
  let sandbox: ReturnType<typeof makeSandbox>;

  beforeEach(() => {
    sandbox = makeSandbox();
    createMock.mockReset();
    createMock.mockResolvedValue(sandbox);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates the sandbox on initialize', async () => {
    const env = new E2BEnvironment({
      image: 'custom',
      timeoutSeconds: 120,
      envVars: {A: '1'},
    });
    expect(env.isInitialized).toBe(false);

    await env.initialize();

    expect(env.isInitialized).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        template: 'custom',
        timeoutMs: 120_000,
        envs: {A: '1'},
      }),
    );
  });

  it('creates the sandbox with the default template and time-to-live', async () => {
    const env = new E2BEnvironment();

    await env.initialize();

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({template: 'base', timeoutMs: 300_000}),
    );
  });

  it('passes the API key to the sandbox', async () => {
    const env = new E2BEnvironment({apiKey: 'test-key'});

    await env.initialize();

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({apiKey: 'test-key'}),
    );
  });

  it('is idempotent on initialize', async () => {
    const env = new E2BEnvironment();

    await env.initialize();
    await env.initialize();

    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('kills the sandbox on close and is idempotent', async () => {
    const env = new E2BEnvironment();
    await env.initialize();

    await env.close();
    await env.close();

    expect(sandbox.kill).toHaveBeenCalledTimes(1);
    expect(env.isInitialized).toBe(false);
    expect(() => env.workingDir).toThrow('Sandbox is not started');
  });

  it('exposes the sandbox home only once started', async () => {
    const env = new E2BEnvironment();
    expect(() => env.workingDir).toThrow(
      'Sandbox is not started. Call initialize() first.',
    );

    await env.initialize();

    expect(env.workingDir).toBe(SANDBOX_HOME);
  });

  it('rejects execute before initialize', async () => {
    const env = new E2BEnvironment();

    await expect(env.execute('echo hi')).rejects.toThrow(
      'Sandbox is not started. Call initialize() first.',
    );
  });

  it('returns the command result and extends the time-to-live', async () => {
    sandbox.commands.run.mockResolvedValue({
      exitCode: 0,
      stdout: 'out',
      stderr: 'err',
    });
    const env = new E2BEnvironment();
    await env.initialize();

    const result = await env.execute('echo out');

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'out',
      stderr: 'err',
      timedOut: false,
    });
    expect(sandbox.setTimeout).toHaveBeenCalledWith(300_000);
  });

  it('reports a non-zero exit as a result rather than an error', async () => {
    sandbox.commands.run.mockRejectedValue(
      new CommandExitError({
        exitCode: 2,
        stdout: 'partial',
        stderr: 'boom',
        error: 'failed',
      }),
    );
    const env = new E2BEnvironment();
    await env.initialize();

    const result = await env.execute('false');

    expect(result).toEqual({
      exitCode: 2,
      stdout: 'partial',
      stderr: 'boom',
      timedOut: false,
    });
  });

  it('reports a timeout as a result rather than an error', async () => {
    sandbox.commands.run.mockRejectedValue(new TimeoutError('too slow'));
    const env = new E2BEnvironment();
    await env.initialize();

    const result = await env.execute('sleep 999');

    expect(result).toEqual({
      exitCode: -1,
      stdout: '',
      stderr: '',
      timedOut: true,
    });
  });

  it('disables the command timeout when no timeout is given', async () => {
    sandbox.commands.run.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    const env = new E2BEnvironment();
    await env.initialize();

    await env.execute('echo hi');

    expect(sandbox.commands.run).toHaveBeenCalledWith('echo hi', {
      cwd: SANDBOX_HOME,
      timeoutMs: 0,
    });
  });

  it('converts the command timeout to milliseconds', async () => {
    sandbox.commands.run.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    const env = new E2BEnvironment();
    await env.initialize();

    await env.execute('echo hi', 30);

    expect(sandbox.commands.run).toHaveBeenCalledWith('echo hi', {
      cwd: SANDBOX_HOME,
      timeoutMs: 30_000,
    });
  });

  it('propagates an unexpected error from a command', async () => {
    sandbox.commands.run.mockRejectedValue(new Error('connection reset'));
    const env = new E2BEnvironment();
    await env.initialize();

    await expect(env.execute('echo hi')).rejects.toThrow('connection reset');
  });

  it.each([
    ['a string', 'not an error'],
    ['null', null],
    ['an object without a name', {}],
  ])('propagates a rejection that is %s', async (_label, thrown) => {
    sandbox.commands.run.mockRejectedValue(thrown);
    const env = new E2BEnvironment();
    await env.initialize();

    await expect(env.execute('echo hi')).rejects.toBe(thrown);
  });

  it('reads a file relative to the sandbox home', async () => {
    sandbox.files.read.mockResolvedValue(bytes('data'));
    const env = new E2BEnvironment();
    await env.initialize();

    const data = await env.readFile('notes.txt');

    expect(data).toEqual(bytes('data'));
    expect(sandbox.files.read).toHaveBeenCalledWith('/home/user/notes.txt', {
      format: 'bytes',
    });
  });

  it('reads an absolute path unchanged', async () => {
    sandbox.files.read.mockResolvedValue(bytes('x'));
    const env = new E2BEnvironment();
    await env.initialize();

    await env.readFile('/etc/hostname');

    expect(sandbox.files.read).toHaveBeenCalledWith('/etc/hostname', {
      format: 'bytes',
    });
  });

  it('reports a missing file as ENOENT', async () => {
    sandbox.files.read.mockRejectedValue(new FileNotFoundError('nope'));
    const env = new E2BEnvironment();
    await env.initialize();

    const rejection = await env.readFile('missing.txt').catch((e) => e);

    expect(rejection).toMatchObject({
      code: 'ENOENT',
      message: expect.stringContaining('/home/user/missing.txt'),
    });
    expect(rejection.message).toMatch(/ENOENT/);
  });

  it('propagates an unexpected error from a read', async () => {
    sandbox.files.read.mockRejectedValue(new Error('disk gone'));
    const env = new E2BEnvironment();
    await env.initialize();

    await expect(env.readFile('notes.txt')).rejects.toThrow('disk gone');
  });

  it('writes a string to a path relative to the sandbox home', async () => {
    const env = new E2BEnvironment();
    await env.initialize();

    await env.writeFile('sub/out.txt', 'hello');

    expect(sandbox.files.write).toHaveBeenCalledWith(
      '/home/user/sub/out.txt',
      'hello',
    );
  });

  it('writes raw bytes without corrupting them', async () => {
    const env = new E2BEnvironment();
    await env.initialize();
    const content = new Uint8Array([0, 1, 2, 255]);

    await env.writeFile('out.bin', content);

    const [writtenPath, written] = sandbox.files.write.mock.calls[0];
    expect(writtenPath).toBe('/home/user/out.bin');
    expect(written).toBeInstanceOf(Blob);
    if (typeof written === 'string') {
      expect.fail('expected raw bytes to be written as a Blob');
    }
    expect(new Uint8Array(await written.arrayBuffer())).toEqual(content);
  });

  it('extends the time-to-live with the configured value', async () => {
    sandbox.files.read.mockResolvedValue(bytes('1'));
    const env = new E2BEnvironment({timeoutSeconds: 200});
    await env.initialize();

    await env.readFile('a.txt');

    expect(sandbox.setTimeout).toHaveBeenCalledWith(200_000);
  });

  it('recreates the sandbox once it has expired', async () => {
    const expired = makeSandbox(false);
    const fresh = makeSandbox();
    fresh.files.read.mockResolvedValue(bytes('fresh'));
    createMock.mockReset();
    createMock.mockResolvedValueOnce(expired).mockResolvedValueOnce(fresh);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const env = new E2BEnvironment();
    await env.initialize();

    const data = await env.readFile('a.txt');

    expect(data).toEqual(bytes('fresh'));
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(expired.setTimeout).not.toHaveBeenCalled();
    // The replacement is created with a full time-to-live, so it needs no
    // keepalive of its own.
    expect(fresh.setTimeout).not.toHaveBeenCalled();
    expect(env.isInitialized).toBe(true);
    const expiryWarnings = warn.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.includes('expired'),
    );
    expect(expiryWarnings).toHaveLength(1);
  });
});
