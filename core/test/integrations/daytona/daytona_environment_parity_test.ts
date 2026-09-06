/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python reference suite for `DaytonaEnvironment`, ported test for
 * test from `tests/unittests/integrations/daytona/test_daytona_environment.py`
 * (google/adk-python). Each `it` keeps its Python `test_*` name, so the two
 * suites can be compared by name.
 *
 * Three assertions could not be carried over literally:
 * - `isinstance(params, CreateSandboxFrom*Params)` — those are erased type
 *   aliases in TypeScript, so the tests assert the discriminating field.
 * - `env._sandbox is sandbox` — reading a private field is not allowed here,
 *   so the tests assert observable behaviour instead.
 * - `client.close()` — the TypeScript client disposes through
 *   `Symbol.asyncDispose` and has no `close`.
 */

import type {DaytonaConfig} from '@daytona/sdk';
import {DaytonaEnvironment} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createDaytonaError,
  createFakeClient,
  createFakeSandbox,
  type FakeClient,
  type FakeSandbox,
} from './daytona_test_fakes.js';

const {DaytonaMock} = vi.hoisted(() => ({
  DaytonaMock: vi.fn<(config?: DaytonaConfig) => unknown>(),
}));

vi.mock('@daytona/sdk', () => ({Daytona: DaytonaMock}));

describe('DaytonaEnvironment (adk-python parity suite)', () => {
  let sandbox: FakeSandbox;
  let client: FakeClient;

  beforeEach(() => {
    sandbox = createFakeSandbox();
    client = createFakeClient(sandbox);
    DaytonaMock.mockReset();
    DaytonaMock.mockReturnValue(client);
  });

  it('test_initialize_creates_sandbox', async () => {
    const env = new DaytonaEnvironment({
      image: 'custom-image',
      envVars: {A: '1'},
    });
    expect(env.isInitialized).toBe(false);

    await env.initialize();

    expect(env.isInitialized).toBe(true);
    expect(DaytonaMock).toHaveBeenCalledTimes(1);
    expect(client.create).toHaveBeenCalledTimes(1);

    const params = client.create.mock.calls[0][0];
    expect(params).toMatchObject({
      image: 'custom-image',
      envVars: {A: '1'},
      autoStopInterval: 5,
      autoDeleteInterval: 0,
    });
    expect(params).not.toHaveProperty('language');
    expect(params).not.toHaveProperty('snapshot');
    // Stands in for `env._sandbox is sandbox`: the getter only answers while a
    // sandbox is live.
    expect(env.workingDir).toBe('/workspaces');
  });

  it('test_initialize_creates_sandbox_default', async () => {
    const env = new DaytonaEnvironment({envVars: {B: '2'}});

    await env.initialize();

    expect(DaytonaMock).toHaveBeenCalledTimes(1);
    expect(client.create).toHaveBeenCalledTimes(1);

    const params = client.create.mock.calls[0][0];
    expect(params).toMatchObject({
      language: 'python',
      envVars: {B: '2'},
      autoStopInterval: 5,
      autoDeleteInterval: 0,
    });
    expect(params).not.toHaveProperty('image');
    expect(env.workingDir).toBe('/workspaces');
  });

  it('test_initialize_is_idempotent', async () => {
    const env = new DaytonaEnvironment();

    await env.initialize();
    await env.initialize();

    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it('test_close_deletes_sandbox_and_is_idempotent', async () => {
    const env = new DaytonaEnvironment();
    await env.initialize();
    expect(env.isInitialized).toBe(true);

    await env.close();

    expect(sandbox.delete).toHaveBeenCalledTimes(1);
    expect(client[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
    expect(env.isInitialized).toBe(false);
    expect(() => env.workingDir).toThrow(/Sandbox is not started/);

    await env.close();

    expect(sandbox.delete).toHaveBeenCalledTimes(1);
    expect(client[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  });

  it('test_working_dir_requires_initialize', () => {
    const env = new DaytonaEnvironment();

    expect(() => env.workingDir).toThrow(
      'Sandbox is not started. Call initialize() first.',
    );
  });

  it('test_execute_before_initialize_raises', async () => {
    const env = new DaytonaEnvironment();

    await expect(env.execute('echo hi')).rejects.toThrow(
      'Sandbox is not started. Call initialize() first.',
    );
  });

  it('test_execute_success', async () => {
    sandbox.process.executeCommand.mockResolvedValue({
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
    expect(sandbox.refreshActivity).toHaveBeenCalledTimes(1);
  });

  it('test_execute_timeout', async () => {
    sandbox.process.executeCommand.mockRejectedValue(
      createDaytonaError('DaytonaError', 'timeout occurred'),
    );
    const env = new DaytonaEnvironment();
    await env.initialize();

    const result = await env.execute('sleep 999');

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  it('test_read_file_returns_bytes', async () => {
    sandbox.fs.downloadFile.mockResolvedValue(Buffer.from('data'));
    const env = new DaytonaEnvironment();
    await env.initialize();

    const data = await env.readFile('notes.txt');

    expect(Buffer.from(data).toString('utf-8')).toBe('data');
    expect(sandbox.fs.downloadFile).toHaveBeenCalledTimes(1);
    expect(sandbox.fs.downloadFile).toHaveBeenCalledWith(
      '/workspaces/notes.txt',
    );
    expect(sandbox.refreshActivity).toHaveBeenCalledTimes(1);
  });

  it('test_read_file_absolute_path_passthrough', async () => {
    sandbox.fs.downloadFile.mockResolvedValue(Buffer.from('x'));
    const env = new DaytonaEnvironment();
    await env.initialize();

    await env.readFile('/etc/hostname');

    expect(sandbox.fs.downloadFile).toHaveBeenCalledTimes(1);
    expect(sandbox.fs.downloadFile).toHaveBeenCalledWith('/etc/hostname');
  });

  it('test_read_file_missing_raises', async () => {
    sandbox.fs.downloadFile.mockResolvedValue(null);
    const env = new DaytonaEnvironment();
    await env.initialize();

    await expect(env.readFile('missing.txt')).rejects.toMatchObject({
      code: 'ENOENT',
      message: expect.stringContaining('/workspaces/missing.txt'),
    });
  });

  it('test_write_file_resolves_relative_path', async () => {
    const env = new DaytonaEnvironment();
    await env.initialize();

    await env.writeFile('sub/out.txt', 'hello');

    expect(sandbox.refreshActivity).toHaveBeenCalledTimes(1);
    expect(sandbox.fs.uploadFile).toHaveBeenCalledTimes(1);
    expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
      Buffer.from('hello', 'utf-8'),
      '/workspaces/sub/out.txt',
    );
  });

  it('test_initialize_propagates_api_key_and_url', async () => {
    const env = new DaytonaEnvironment({apiKey: 'my-key', apiUrl: 'my-url'});

    await env.initialize();

    expect(DaytonaMock).toHaveBeenCalledTimes(1);
    expect(DaytonaMock).toHaveBeenCalledWith({
      apiKey: 'my-key',
      apiUrl: 'my-url',
    });
  });

  it('test_write_file_creates_parent_directory', async () => {
    const env = new DaytonaEnvironment();
    await env.initialize();

    await env.writeFile('sub/nested/file.txt', 'content');

    expect(sandbox.fs.createFolder.mock.calls).toEqual([
      ['/workspaces', '755'],
      ['/workspaces/sub', '755'],
      ['/workspaces/sub/nested', '755'],
    ]);
    expect(sandbox.fs.uploadFile).toHaveBeenCalledTimes(1);
    expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
      Buffer.from('content', 'utf-8'),
      '/workspaces/sub/nested/file.txt',
    );
  });

  it('test_read_file_raises_file_not_found_on_daytona_not_found', async () => {
    const notFound = createDaytonaError('DaytonaNotFoundError', 'not found');
    sandbox.fs.downloadFile.mockRejectedValue(notFound);
    const env = new DaytonaEnvironment();
    await env.initialize();

    await expect(env.readFile('missing.txt')).rejects.toMatchObject({
      code: 'ENOENT',
      cause: notFound,
    });
  });
});
