/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/daytona/test_daytona_environment.py`,
 * google/adk-python `main`. Every `it()` keeps the reference test name, so a
 * reviewer can match the two suites by grep.
 */

import {DaytonaEnvironment} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  clients,
  currentSandbox,
  DaytonaError,
  DaytonaNotFoundError,
  resetFakeDaytona,
} from './fake_daytona.js';

vi.mock('@daytona/sdk', () => import('./fake_daytona.js'));

describe('DaytonaEnvironment', () => {
  beforeEach(() => {
    resetFakeDaytona();
  });

  it('test_initialize_creates_sandbox', async () => {
    const env = new DaytonaEnvironment({
      image: 'custom-image',
      envVars: {A: '1'},
    });
    expect(env.isInitialized).toBe(false);

    await env.initialize();

    expect(env.isInitialized).toBe(true);
    expect(clients).toHaveLength(1);
    expect(clients[0].create).toHaveBeenCalledOnce();
    expect(clients[0].create).toHaveBeenCalledWith({
      image: 'custom-image',
      envVars: {A: '1'},
      autoStopInterval: 5,
      autoDeleteInterval: 0,
    });
  });

  it('test_initialize_creates_sandbox_default', async () => {
    const env = new DaytonaEnvironment({envVars: {B: '2'}});

    await env.initialize();

    expect(clients).toHaveLength(1);
    expect(clients[0].create).toHaveBeenCalledOnce();
    // Deep equality, so an `image` key here would fail the assertion.
    expect(clients[0].create).toHaveBeenCalledWith({
      language: 'python',
      envVars: {B: '2'},
      autoStopInterval: 5,
      autoDeleteInterval: 0,
    });
  });

  it('test_initialize_is_idempotent', async () => {
    const env = new DaytonaEnvironment();

    await env.initialize();
    await env.initialize();

    expect(clients).toHaveLength(1);
    expect(clients[0].create).toHaveBeenCalledOnce();
  });

  it('test_close_deletes_sandbox_and_is_idempotent', async () => {
    const env = new DaytonaEnvironment();
    await env.initialize();
    expect(env.isInitialized).toBe(true);

    await env.close();

    expect(currentSandbox().delete).toHaveBeenCalledOnce();
    expect(clients[0].dispose).toHaveBeenCalledOnce();
    expect(env.isInitialized).toBe(false);

    await env.close();

    expect(currentSandbox().delete).toHaveBeenCalledOnce();
    expect(clients[0].dispose).toHaveBeenCalledOnce();
  });

  it('test_working_dir_requires_initialize', () => {
    const env = new DaytonaEnvironment();

    expect(() => env.workingDir).toThrow(
      'Environment is not initialized. Call initialize() first.',
    );
  });

  it('test_execute_before_initialize_raises', async () => {
    const env = new DaytonaEnvironment();

    await expect(env.execute('echo hi')).rejects.toThrow(
      'Environment is not initialized. Call initialize() first.',
    );
  });

  it('test_execute_success', async () => {
    currentSandbox().process.executeCommand.mockResolvedValue({
      exitCode: 0,
      result: 'out',
      artifacts: {stdout: 'out'},
    });
    const env = new DaytonaEnvironment();
    await env.initialize();

    const result = await env.execute('echo out');

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'out',
      stderr: '',
      timedOut: false,
    });
    expect(currentSandbox().refreshActivity).toHaveBeenCalledOnce();
  });

  it('test_execute_timeout', async () => {
    currentSandbox().process.executeCommand.mockRejectedValue(
      new DaytonaError('timeout occurred'),
    );
    const env = new DaytonaEnvironment();
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
    currentSandbox().fs.downloadFile.mockResolvedValue(Buffer.from('data'));
    const env = new DaytonaEnvironment();
    await env.initialize();

    const data = await env.readFile('notes.txt');

    expect(Buffer.from(data).toString('utf-8')).toBe('data');
    expect(currentSandbox().fs.downloadFile).toHaveBeenCalledOnce();
    expect(currentSandbox().fs.downloadFile).toHaveBeenCalledWith(
      '/workspaces/notes.txt',
    );
    expect(currentSandbox().refreshActivity).toHaveBeenCalledOnce();
  });

  it('test_read_file_absolute_path_passthrough', async () => {
    currentSandbox().fs.downloadFile.mockResolvedValue(Buffer.from('x'));
    const env = new DaytonaEnvironment();
    await env.initialize();

    await env.readFile('/etc/hostname');

    expect(currentSandbox().fs.downloadFile).toHaveBeenCalledOnce();
    expect(currentSandbox().fs.downloadFile).toHaveBeenCalledWith(
      '/etc/hostname',
    );
  });

  it('test_read_file_missing_raises', async () => {
    currentSandbox().fs.downloadFile.mockResolvedValue(undefined);
    const env = new DaytonaEnvironment();
    await env.initialize();

    await expect(env.readFile('missing.txt')).rejects.toThrow(
      'File not found: /workspaces/missing.txt',
    );
  });

  it('test_write_file_resolves_relative_path', async () => {
    const env = new DaytonaEnvironment();
    await env.initialize();

    await env.writeFile('sub/out.txt', 'hello');

    expect(currentSandbox().refreshActivity).toHaveBeenCalledOnce();
    expect(currentSandbox().fs.uploadFile).toHaveBeenCalledOnce();
    expect(currentSandbox().fs.uploadFile).toHaveBeenCalledWith(
      Buffer.from('hello'),
      '/workspaces/sub/out.txt',
    );
  });

  it('test_initialize_propagates_api_key_and_url', async () => {
    const env = new DaytonaEnvironment({apiKey: 'my-key', apiUrl: 'my-url'});

    await env.initialize();

    expect(clients).toHaveLength(1);
    expect(clients[0].config).toEqual({apiKey: 'my-key', apiUrl: 'my-url'});
  });

  it('test_write_file_creates_parent_directory', async () => {
    const env = new DaytonaEnvironment();
    await env.initialize();

    await env.writeFile('sub/nested/file.txt', 'content');

    expect(currentSandbox().fs.createFolder.mock.calls).toEqual([
      ['/workspaces', '755'],
      ['/workspaces/sub', '755'],
      ['/workspaces/sub/nested', '755'],
    ]);
    expect(currentSandbox().fs.uploadFile).toHaveBeenCalledOnce();
    expect(currentSandbox().fs.uploadFile).toHaveBeenCalledWith(
      Buffer.from('content'),
      '/workspaces/sub/nested/file.txt',
    );
  });

  it('test_read_file_raises_file_not_found_on_daytona_not_found', async () => {
    const cause = new DaytonaNotFoundError('not found');
    currentSandbox().fs.downloadFile.mockRejectedValue(cause);
    const env = new DaytonaEnvironment();
    await env.initialize();

    await expect(env.readFile('missing.txt')).rejects.toThrow(
      'File not found: /workspaces/missing.txt',
    );
    await expect(env.readFile('missing.txt')).rejects.toMatchObject({cause});
  });
});
