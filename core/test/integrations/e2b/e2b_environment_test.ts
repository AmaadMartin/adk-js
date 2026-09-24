/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The reference test suite, ported one for one.
 *
 * Source: adk-python `main`,
 * `tests/unittests/integrations/e2b/test_e2b_environment.py`.
 *
 * Each test keeps its reference name, including the snake_case, so a reviewer
 * can grep for the original. Two kinds of adaptation appear, each marked at
 * the test that carries it:
 *
 * - Python asserts on the private `env._sandbox`. Reaching a private member
 *   from a test is banned here, so those assertions are re-expressed through
 *   observable behaviour.
 * - The Python SDK takes seconds and the JS SDK takes milliseconds, so the
 *   timeout assertions expect a value 1000 times larger.
 */

import {E2BEnvironment} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  commandExitError,
  commandResult,
  createFakeSandbox,
  namedError,
  type FakeSandbox,
} from './e2b_test_fakes.js';

const {sandboxCreate} = vi.hoisted(() => ({sandboxCreate: vi.fn()}));

vi.mock('e2b', () => ({Sandbox: {create: sandboxCreate}}));

describe('E2BEnvironment (ported reference suite)', () => {
  let sandbox: FakeSandbox;

  beforeEach(() => {
    vi.clearAllMocks();
    sandbox = createFakeSandbox();
    sandboxCreate.mockResolvedValue(sandbox);
  });

  it('test_initialize_creates_sandbox', async () => {
    const env = new E2BEnvironment({
      image: 'custom',
      timeoutSeconds: 120,
      envVars: {A: '1'},
    });
    expect(env.isInitialized).toBe(false);

    await env.initialize();

    expect(env.isInitialized).toBe(true);
    expect(sandboxCreate).toHaveBeenCalledTimes(1);
    // `timeoutMs`, not `timeout`, and 120_000, not 120: the JS SDK takes
    // milliseconds.
    expect(sandboxCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        template: 'custom',
        timeoutMs: 120_000,
        envs: {A: '1'},
      }),
    );

    // Python asserts `env._sandbox is sandbox`. Prove the same identity
    // behaviourally: an operation has to reach that sandbox.
    sandbox.files.read.mockResolvedValue(new TextEncoder().encode('mine'));
    expect(await env.readFile('a.txt')).toEqual(
      new TextEncoder().encode('mine'),
    );
  });

  it('test_initialize_is_idempotent', async () => {
    const env = new E2BEnvironment();

    await env.initialize();
    await env.initialize();

    expect(sandboxCreate).toHaveBeenCalledTimes(1);
  });

  it('test_close_kills_sandbox_and_is_idempotent', async () => {
    const env = new E2BEnvironment();
    await env.initialize();
    expect(env.isInitialized).toBe(true);

    await env.close();

    expect(sandbox.kill).toHaveBeenCalledTimes(1);
    expect(env.isInitialized).toBe(false);
    // Python asserts `env._sandbox is None`; here the discarded sandbox shows
    // up as a subsequent operation rejecting.
    await expect(env.execute('echo hi')).rejects.toThrow(
      'Sandbox is not started',
    );

    await env.close();

    expect(sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it('test_working_dir_requires_initialize', () => {
    const env = new E2BEnvironment();

    expect(() => env.workingDir).toThrow('Sandbox is not started');
  });

  it('test_execute_before_initialize_raises', async () => {
    const env = new E2BEnvironment();

    await expect(env.execute('echo hi')).rejects.toThrow(
      'Sandbox is not started',
    );
  });

  it('test_execute_success', async () => {
    sandbox.commands.run.mockResolvedValue(
      commandResult({stdout: 'out', stderr: 'err', exitCode: 0}),
    );
    const env = new E2BEnvironment();
    await env.initialize();

    const result = await env.execute('echo out');

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'out',
      stderr: 'err',
      timedOut: false,
    });
    expect(sandbox.setTimeout).toHaveBeenCalled();
  });

  it('test_execute_nonzero_exit_is_normal_result', async () => {
    sandbox.commands.run.mockRejectedValue(
      commandExitError({exitCode: 2, stdout: 'partial', stderr: 'boom'}),
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

  it('test_execute_timeout', async () => {
    sandbox.commands.run.mockRejectedValue(
      namedError('TimeoutError', 'too slow'),
    );
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

  it('test_read_file_returns_bytes', async () => {
    const data = new TextEncoder().encode('data');
    sandbox.files.read.mockResolvedValue(data);
    const env = new E2BEnvironment();
    await env.initialize();

    expect(await env.readFile('notes.txt')).toEqual(data);
    expect(sandbox.files.read).toHaveBeenCalledExactlyOnceWith(
      '/home/user/notes.txt',
      {format: 'bytes'},
    );
  });

  it('test_read_file_absolute_path_passthrough', async () => {
    sandbox.files.read.mockResolvedValue(new TextEncoder().encode('x'));
    const env = new E2BEnvironment();
    await env.initialize();

    await env.readFile('/etc/hostname');

    expect(sandbox.files.read).toHaveBeenCalledExactlyOnceWith(
      '/etc/hostname',
      {format: 'bytes'},
    );
  });

  it('test_read_file_missing_raises', async () => {
    sandbox.files.read.mockRejectedValue(
      namedError('FileNotFoundError', 'nope'),
    );
    const env = new E2BEnvironment();
    await env.initialize();

    await expect(env.readFile('missing.txt')).rejects.toThrow(
      expect.objectContaining({
        code: 'ENOENT',
        message:
          "ENOENT: no such file or directory, open '/home/user/missing.txt'",
      }),
    );
  });

  it('test_write_file_resolves_relative_path', async () => {
    const env = new E2BEnvironment();
    await env.initialize();

    await env.writeFile('sub/out.txt', 'hello');

    expect(sandbox.files.write).toHaveBeenCalledExactlyOnceWith(
      '/home/user/sub/out.txt',
      'hello',
    );
  });

  it('test_keepalive_extends_timeout_when_running', async () => {
    sandbox.files.read.mockResolvedValue(new TextEncoder().encode('1'));
    const env = new E2BEnvironment({timeoutSeconds: 200});
    await env.initialize();

    await env.readFile('a.txt');

    // Python asserts `set_timeout(200)`. The JS SDK takes milliseconds.
    expect(sandbox.setTimeout).toHaveBeenCalledWith(200_000);
  });

  it('test_lazy_recreate_when_expired', async () => {
    const expired = createFakeSandbox(false);
    const fresh = createFakeSandbox(true);
    const freshBytes = new TextEncoder().encode('fresh');
    fresh.files.read.mockResolvedValue(freshBytes);
    sandboxCreate.mockReset();
    sandboxCreate.mockResolvedValueOnce(expired).mockResolvedValueOnce(fresh);

    const env = new E2BEnvironment();
    await env.initialize();
    const data = await env.readFile('a.txt');

    // Python asserts `env._sandbox is fresh`; the returned bytes prove it.
    expect(data).toEqual(freshBytes);
    expect(sandboxCreate).toHaveBeenCalledTimes(2);
    expect(expired.setTimeout).not.toHaveBeenCalled();
  });
});
