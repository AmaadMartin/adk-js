/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CloudRunSandboxCodeExecutor} from '@google/adk';
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

const NETNS_WARNINGS =
  'Failed to cleanup network namespace: device busy\n' +
  'sandbox: failed to unmount netns file\n';

describe('CloudRunSandboxCodeExecutor', () => {
  const invocationContext = createInvocationContext();

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(realSpawn);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('strips the netns teardown warnings and keeps every other line in order', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new CloudRunSandboxCodeExecutor().executeCode({
      invocationContext,
      codeExecutionInput: executionInput('print(1)'),
    });
    child.stderr.emit(
      'data',
      'first real line\n' +
        'Failed to cleanup network namespace: device busy\n' +
        'second real line\n' +
        'sandbox: failed to unmount netns file\n' +
        'third real line\n',
    );
    child.emit('close', 0, null);
    const result = await pending;

    expect(result.stderr).toBe(
      'first real line\nsecond real line\nthird real line',
    );
  });

  it('reports no stderr when the sandbox only wrote netns warnings', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new CloudRunSandboxCodeExecutor().executeCode({
      invocationContext,
      codeExecutionInput: executionInput('print(1)'),
    });
    child.stdout.emit('data', '1\n');
    child.stderr.emit('data', NETNS_WARNINGS);
    child.emit('close', 0, null);
    const result = await pending;

    expect(result).toEqual({
      stdout: '1\n',
      stderr: '',
      outputFiles: [],
      exitCode: 0,
    });
  });

  it('falls back to the timeout message when only netns warnings remain', async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new CloudRunSandboxCodeExecutor({
      timeoutSeconds: 2,
    }).executeCode({
      invocationContext,
      codeExecutionInput: executionInput('while True: pass'),
    });
    child.stderr.emit('data', NETNS_WARNINGS);
    vi.advanceTimersByTime(2000);
    child.emit('close', null, 'SIGKILL');
    const result = await pending;

    expect(result.stderr).toBe('Code execution timed out after 2 seconds.');
    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
  });

  it('keeps the real stderr lines of a timed-out run', async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new CloudRunSandboxCodeExecutor({
      timeoutSeconds: 2,
    }).executeCode({
      invocationContext,
      codeExecutionInput: executionInput('while True: pass'),
    });
    child.stderr.emit('data', `slow start\n${NETNS_WARNINGS}`);
    vi.advanceTimersByTime(2000);
    child.emit('close', null, 'SIGKILL');
    const result = await pending;

    expect(result.stderr).toBe('slow start');
  });

  it('reports the timeout status when the child died from another signal', async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new CloudRunSandboxCodeExecutor({
      timeoutSeconds: 2,
    }).executeCode({
      invocationContext,
      codeExecutionInput: executionInput('while True: pass'),
    });
    vi.advanceTimersByTime(2000);
    // The wall-clock bound elapsed, so the run is a timeout whatever killed
    // the child. Reporting the signal would give -15 here.
    child.emit('close', null, 'SIGTERM');
    const result = await pending;

    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
  });

  it('reports the negated signal number for a child killed by a signal', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new CloudRunSandboxCodeExecutor().executeCode({
      invocationContext,
      codeExecutionInput: executionInput('print(1)'),
    });
    child.emit('close', null, 'SIGTERM');
    const result = await pending;

    expect(result.exitCode).toBe(-15);
  });

  it('survives an EPIPE on the sandbox stdin and returns the child result', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new CloudRunSandboxCodeExecutor().executeCode({
      invocationContext,
      codeExecutionInput: executionInput('print(1)'),
    });
    // An unhandled stream 'error' terminates the host process, so this throws
    // here unless the executor listens for it.
    child.stdin.emit(
      'error',
      Object.assign(new Error('write EPIPE'), {code: 'EPIPE'}),
    );
    child.stdout.emit('data', '1\n');
    child.emit('close', 0, null);
    const result = await pending;

    expect(result.stdout).toBe('1\n');
    expect(result.exitCode).toBe(0);
  });

  it('omits --allow-egress by default', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new CloudRunSandboxCodeExecutor().executeCode({
      invocationContext,
      codeExecutionInput: executionInput('print(1)'),
    });
    child.emit('close', 0, null);
    await pending;

    expect(spawnMock).toHaveBeenCalledWith(SANDBOX_BIN, [
      'do',
      process.execPath,
    ]);
  });

  it('runs interpreterPath as the last argument and ignores the language', async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new CloudRunSandboxCodeExecutor({
      interpreterPath: '/usr/bin/python3',
    }).executeCode({
      invocationContext,
      codeExecutionInput: executionInput('print(1)'),
    });
    child.emit('close', 0, null);
    await pending;

    expect(spawnMock).toHaveBeenCalledWith(SANDBOX_BIN, [
      'do',
      '/usr/bin/python3',
    ]);
  });

  it('arms no timer when timeoutSeconds is null', async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new CloudRunSandboxCodeExecutor({
      timeoutSeconds: null,
    }).executeCode({
      invocationContext,
      codeExecutionInput: executionInput('while True: pass'),
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', 0, null);

    expect((await pending).exitCode).toBe(0);
  });
});
