/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python reference tests for `CloudRunSandboxCodeExecutor`, ported to
 * TypeScript. Each `it(...)` keeps its Python name verbatim, so a reviewer can
 * match the two suites by grep.
 *
 * Source: adk-python `main`,
 * `tests/unittests/integrations/cloud_run/test_cloud_run_sandbox_code_executor.py`.
 */

import {CloudRunSandboxCodeExecutor} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  SANDBOX_BIN,
  TIMEOUT_EXIT_CODE,
  createFakeChild,
  createInvocationContext,
  executionInput,
  realSpawn,
} from './cloud_run_sandbox_test_utils.js';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

describe('CloudRunSandboxCodeExecutor (adk-python parity)', () => {
  const invocationContext = createInvocationContext();

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(realSpawn);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_init_default', () => {
    const executor = new CloudRunSandboxCodeExecutor();

    expect(executor.stateful).toBe(false);
    expect(executor.optimizeDataFile).toBe(false);
    expect(executor.sandboxBin).toBe('/usr/local/gcp/bin/sandbox');
    expect(executor.allowEgress).toBe(false);
    // Bounded by default, so generated code that never terminates cannot hang
    // the agent waiting on it.
    expect(executor.timeoutSeconds).toBe(300);
  });

  it('test_init_accepts_timeout_seconds_none', () => {
    const executor = new CloudRunSandboxCodeExecutor({timeoutSeconds: null});

    expect(executor.timeoutSeconds).toBeUndefined();
  });

  it('test_init_stateful_raises_error', () => {
    expect(() => new CloudRunSandboxCodeExecutor({stateful: true})).toThrow(
      'Cannot set `stateful: true` in CloudRunSandboxCodeExecutor.',
    );
  });

  it('test_init_optimize_data_file_raises_error', () => {
    expect(
      () => new CloudRunSandboxCodeExecutor({optimizeDataFile: true}),
    ).toThrow(
      'Cannot set `optimizeDataFile: true` in CloudRunSandboxCodeExecutor.',
    );
  });

  it('test_execute_code_success', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const executor = new CloudRunSandboxCodeExecutor();

    const pending = executor.executeCode({
      invocationContext,
      codeExecutionInput: executionInput('print("hello world")'),
    });
    child.stdout.emit('data', 'hello world\n');
    child.emit('close', 0, null);
    const result = await pending;

    expect(result).toEqual({
      stdout: 'hello world\n',
      stderr: '',
      outputFiles: [],
      exitCode: 0,
    });
    expect(spawnMock).toHaveBeenCalledWith(SANDBOX_BIN, [
      'do',
      process.execPath,
    ]);
    expect(child.stdin.end).toHaveBeenCalledWith('print("hello world")');
  });

  it('test_execute_code_with_egress_and_custom_bin', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const executor = new CloudRunSandboxCodeExecutor({
      sandboxBin: '/usr/bin/custom-sandbox',
      allowEgress: true,
      timeoutSeconds: 10,
    });

    const pending = executor.executeCode({
      invocationContext,
      codeExecutionInput: executionInput("import requests; print('ok')"),
    });
    child.stdout.emit('data', 'egress success\n');
    child.emit('close', 0, null);
    const result = await pending;

    expect(result.stdout).toBe('egress success\n');
    expect(spawnMock).toHaveBeenCalledWith('/usr/bin/custom-sandbox', [
      'do',
      '--allow-egress',
      process.execPath,
    ]);
    expect(child.stdin.end).toHaveBeenCalledWith(
      "import requests; print('ok')",
    );
  });

  it('test_execute_code_with_error', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const executor = new CloudRunSandboxCodeExecutor();

    const pending = executor.executeCode({
      invocationContext,
      codeExecutionInput: executionInput('raise ValueError("Test error")'),
    });
    child.stderr.emit('data', 'Traceback ... ValueError: Test error\n');
    child.emit('close', 1, null);
    const result = await pending;

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ValueError: Test error');
    expect(result.exitCode).toBe(1);
  });

  it('test_execute_code_timeout', async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const executor = new CloudRunSandboxCodeExecutor({timeoutSeconds: 5});

    const pending = executor.executeCode({
      invocationContext,
      codeExecutionInput: executionInput('import time\ntime.sleep(10)'),
    });
    child.stdout.emit('data', 'partial stdout');
    child.stderr.emit('data', 'partial stderr');
    vi.advanceTimersByTime(5000);
    child.emit('close', null, 'SIGKILL');
    const result = await pending;

    expect(result.stdout).toBe('partial stdout');
    expect(result.stderr).toBe('partial stderr');
    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    // The read ends are released with the kill, so 'close' can arrive even
    // when a survivor still holds the inherited pipes.
    expect(child.stdout.destroy).toHaveBeenCalled();
    expect(child.stderr.destroy).toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'test_explicit_timeout_beats_the_default',
    async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'adk_js_cloud_run_sandbox_'),
      );
      const fakeSandbox = path.join(tempDir, 'sandbox');
      // The background `sleep` inherits the pipes and outlives the kill, so
      // 'close' only arrives because the executor destroys the read ends.
      await fs.writeFile(
        fakeSandbox,
        '#!/bin/sh\necho "sandbox starting"\nsleep 30 &\nsleep 30\n',
      );
      await fs.chmod(fakeSandbox, 0o755);

      const executor = new CloudRunSandboxCodeExecutor({
        sandboxBin: fakeSandbox,
        timeoutSeconds: 1,
      });
      const started = Date.now();
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: executionInput('while True: pass'),
      });
      const elapsedSeconds = (Date.now() - started) / 1000;

      // Well under both the 30s stand-in and the 300s default.
      expect(elapsedSeconds).toBeLessThan(15);
      expect(result.stdout).toContain('sandbox starting');
      expect(result.stderr).toContain('timed out after 1 seconds');
      expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);

      await fs.rm(tempDir, {recursive: true, force: true});
    },
    30000,
  );

  it('test_execute_code_binary_not_found', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const executor = new CloudRunSandboxCodeExecutor();

    const pending = executor.executeCode({
      invocationContext,
      codeExecutionInput: executionInput('print("hello")'),
    });
    child.emit(
      'error',
      Object.assign(new Error('spawn /usr/local/gcp/bin/sandbox ENOENT'), {
        code: 'ENOENT',
      }),
    );
    // Node follows a failed spawn's 'error' with 'close'; the result is
    // already settled and must not change.
    child.emit('close', null, null);
    const result = await pending;

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Sandbox binary "/usr/local/gcp/bin/sandbox" not found. Ensure you are' +
        ' running in an environment with the sandbox tool installed.',
    );
    expect(result.outputFiles).toEqual([]);
    expect(result.exitCode).toBeUndefined();
  });

  it('test_execute_code_unexpected_error', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);
    const executor = new CloudRunSandboxCodeExecutor();

    const pending = executor.executeCode({
      invocationContext,
      codeExecutionInput: executionInput('print("hello")'),
    });
    child.emit('error', new Error('sandbox is unavailable'));
    const result = await pending;

    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Unexpected error running sandbox: sandbox is unavailable',
    );
    expect(result.exitCode).toBeUndefined();
  });
});
