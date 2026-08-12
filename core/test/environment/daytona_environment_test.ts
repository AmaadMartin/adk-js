/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Process} from '@daytona/sdk';
import {DaytonaEnvironment} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/** The SDK does not export this type directly, only the method that returns it. */
type ExecuteResponse = Awaited<ReturnType<Process['executeCommand']>>;

const SANDBOX_HOME = '/workspaces';

const {daytonaConstructor} = vi.hoisted(() => ({
  daytonaConstructor: vi.fn<(config: object) => unknown>(),
}));

vi.mock('@daytona/sdk', () => ({Daytona: daytonaConstructor}));

/** Builds a fake sandbox exposing only the surface the environment uses. */
function makeSandbox() {
  return {
    delete: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    refreshActivity: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    process: {
      executeCommand:
        vi.fn<
          (
            command: string,
            cwd?: string,
            env?: Record<string, string>,
            timeout?: number,
          ) => Promise<ExecuteResponse>
        >(),
    },
    fs: {
      // The environment guards against a missing body, so the double is
      // allowed to resolve nothing.
      downloadFile: vi.fn<(path: string) => Promise<Uint8Array | undefined>>(),
      uploadFile: vi
        .fn<(file: Buffer, path: string) => Promise<void>>()
        .mockResolvedValue(undefined),
      createFolder: vi
        .fn<(path: string, mode: string) => Promise<void>>()
        .mockResolvedValue(undefined),
    },
  };
}

function makeClient(sandbox: ReturnType<typeof makeSandbox>) {
  return {
    create: vi
      .fn<(params: object) => Promise<unknown>>()
      .mockResolvedValue(sandbox),
    [Symbol.asyncDispose]: vi
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined),
  };
}

/** A Daytona error as the SDK builds it from a server response. */
function daytonaError(
  message: string,
  fields: {code?: string; statusCode?: number} = {},
): Error {
  return Object.assign(new Error(message), fields);
}

function executeResponse(
  overrides: Partial<ExecuteResponse> = {},
): ExecuteResponse {
  return {exitCode: 0, result: '', ...overrides};
}

describe('DaytonaEnvironment', () => {
  let sandbox: ReturnType<typeof makeSandbox>;
  let client: ReturnType<typeof makeClient>;

  beforeEach(() => {
    sandbox = makeSandbox();
    client = makeClient(sandbox);
    daytonaConstructor.mockReset();
    daytonaConstructor.mockReturnValue(client);
  });

  describe('initialize', () => {
    it('creates a sandbox from the given image', async () => {
      const env = new DaytonaEnvironment({
        image: 'custom-image',
        envVars: {A: '1'},
      });
      expect(env.isInitialized).toBe(false);

      await env.initialize();

      expect(env.isInitialized).toBe(true);
      expect(client.create).toHaveBeenCalledTimes(1);
      expect(client.create).toHaveBeenCalledWith({
        image: 'custom-image',
        envVars: {A: '1'},
        autoStopInterval: 5,
        autoDeleteInterval: 0,
      });
    });

    it('creates a sandbox from the python snapshot when no image is given', async () => {
      const env = new DaytonaEnvironment({envVars: {B: '2'}});

      await env.initialize();

      expect(client.create).toHaveBeenCalledWith({
        language: 'python',
        envVars: {B: '2'},
        autoStopInterval: 5,
        autoDeleteInterval: 0,
      });
    });

    it('defaults the environment variables to an empty map', async () => {
      const env = new DaytonaEnvironment();

      await env.initialize();

      expect(client.create).toHaveBeenCalledWith(
        expect.objectContaining({envVars: {}}),
      );
    });

    it('creates nothing on a second call', async () => {
      const env = new DaytonaEnvironment();

      await env.initialize();
      await env.initialize();

      expect(client.create).toHaveBeenCalledTimes(1);
    });

    it('passes the API key and URL to the client', async () => {
      const env = new DaytonaEnvironment({
        apiKey: 'test-key',
        apiUrl: 'https://api.test',
      });

      await env.initialize();

      expect(daytonaConstructor).toHaveBeenCalledWith({
        apiKey: 'test-key',
        apiUrl: 'https://api.test',
      });
    });

    it('rounds a sub-minute time-to-live up to one minute', async () => {
      const env = new DaytonaEnvironment({timeoutSeconds: 30});

      await env.initialize();

      expect(client.create).toHaveBeenCalledWith(
        expect.objectContaining({autoStopInterval: 1}),
      );
    });

    it('keeps a zero time-to-live at zero', async () => {
      const env = new DaytonaEnvironment({timeoutSeconds: 0});

      await env.initialize();

      expect(client.create).toHaveBeenCalledWith(
        expect.objectContaining({autoStopInterval: 0}),
      );
    });
  });

  describe('close', () => {
    it('deletes the sandbox, disposes the client, and is idempotent', async () => {
      const env = new DaytonaEnvironment();
      await env.initialize();

      await env.close();
      await env.close();

      expect(sandbox.delete).toHaveBeenCalledTimes(1);
      expect(client[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
      expect(env.isInitialized).toBe(false);
    });

    it('disposes the client even when deleting the sandbox fails', async () => {
      const env = new DaytonaEnvironment();
      await env.initialize();
      sandbox.delete.mockRejectedValue(new Error('sandbox unreachable'));

      await expect(env.close()).rejects.toThrow('sandbox unreachable');

      expect(client[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
      expect(env.isInitialized).toBe(false);
    });
  });

  describe('workingDir', () => {
    it('throws before initialize', () => {
      const env = new DaytonaEnvironment();

      expect(() => env.workingDir).toThrow('Environment is not initialized');
    });

    it('is the sandbox home once initialized', async () => {
      const env = new DaytonaEnvironment();
      await env.initialize();

      expect(env.workingDir).toBe(SANDBOX_HOME);
    });
  });

  describe('before initialize', () => {
    it('rejects execute', async () => {
      const env = new DaytonaEnvironment();

      await expect(env.execute('echo hi')).rejects.toThrow(
        'Environment is not initialized',
      );
    });

    it('rejects readFile', async () => {
      const env = new DaytonaEnvironment();

      await expect(env.readFile('notes.txt')).rejects.toThrow(
        'Environment is not initialized',
      );
    });

    it('rejects writeFile', async () => {
      const env = new DaytonaEnvironment();

      await expect(env.writeFile('notes.txt', 'hi')).rejects.toThrow(
        'Environment is not initialized',
      );
    });
  });

  describe('execute', () => {
    let env: DaytonaEnvironment;

    beforeEach(async () => {
      env = new DaytonaEnvironment();
      await env.initialize();
    });

    it('returns the command output and refreshes the sandbox activity', async () => {
      sandbox.process.executeCommand.mockResolvedValue(
        executeResponse({result: 'out', artifacts: {stdout: 'out'}}),
      );

      const result = await env.execute('echo out');

      expect(result).toEqual({
        exitCode: 0,
        stdout: 'out',
        stderr: '',
        timedOut: false,
      });
      expect(sandbox.refreshActivity).toHaveBeenCalledTimes(1);
    });

    it('falls back to the result field when there are no artifacts', async () => {
      sandbox.process.executeCommand.mockResolvedValue(
        executeResponse({result: 'plain output'}),
      );

      const result = await env.execute('echo out');

      expect(result.stdout).toBe('plain output');
    });

    it('returns a non-zero exit code instead of throwing', async () => {
      sandbox.process.executeCommand.mockResolvedValue(
        executeResponse({
          exitCode: 1,
          result: 'boom',
          artifacts: {stdout: 'boom'},
        }),
      );

      const result = await env.execute('false');

      expect(result).toEqual({
        exitCode: 1,
        stdout: 'boom',
        stderr: '',
        timedOut: false,
      });
    });

    it('passes the constructor timeout by default', async () => {
      sandbox.process.executeCommand.mockResolvedValue(executeResponse());

      await env.execute('sleep 1');

      expect(sandbox.process.executeCommand).toHaveBeenCalledWith(
        'sleep 1',
        undefined,
        undefined,
        300,
      );
    });

    it('passes the per-call timeout truncated to whole seconds', async () => {
      sandbox.process.executeCommand.mockResolvedValue(executeResponse());

      await env.execute('sleep 1', 12.9);

      expect(sandbox.process.executeCommand).toHaveBeenCalledWith(
        'sleep 1',
        undefined,
        undefined,
        12,
      );
    });

    it('reports a timeout carrying the Daytona code as a result', async () => {
      sandbox.process.executeCommand.mockRejectedValue(
        daytonaError('command failed', {code: 'PROCESS_EXECUTION_TIMEOUT'}),
      );

      const result = await env.execute('sleep 999');

      expect(result).toEqual({
        exitCode: -1,
        stdout: '',
        stderr: '',
        timedOut: true,
      });
    });

    it('reports a timeout carrying only a message as a result', async () => {
      sandbox.process.executeCommand.mockRejectedValue(
        new Error('Timeout occurred'),
      );

      const result = await env.execute('sleep 999');

      expect(result.timedOut).toBe(true);
    });

    it('rethrows any other error unchanged', async () => {
      const failure = daytonaError('internal error', {statusCode: 500});
      sandbox.process.executeCommand.mockRejectedValue(failure);

      await expect(env.execute('boom')).rejects.toBe(failure);
    });
  });

  describe('readFile', () => {
    let env: DaytonaEnvironment;

    beforeEach(async () => {
      env = new DaytonaEnvironment();
      await env.initialize();
    });

    it('resolves a relative path against the sandbox home', async () => {
      sandbox.fs.downloadFile.mockResolvedValue(Buffer.from('data'));

      const content = await env.readFile('notes.txt');

      expect(Buffer.from(content).toString()).toBe('data');
      expect(sandbox.fs.downloadFile).toHaveBeenCalledWith(
        '/workspaces/notes.txt',
      );
      expect(sandbox.refreshActivity).toHaveBeenCalledTimes(1);
    });

    it('passes an absolute path through', async () => {
      sandbox.fs.downloadFile.mockResolvedValue(Buffer.from('x'));

      await env.readFile('/etc/hostname');

      expect(sandbox.fs.downloadFile).toHaveBeenCalledWith('/etc/hostname');
    });

    it('rejects when the sandbox returns no content', async () => {
      sandbox.fs.downloadFile.mockResolvedValue(undefined);

      await expect(env.readFile('missing.txt')).rejects.toThrow(
        'File not found: /workspaces/missing.txt',
      );
    });

    it('rejects when the download fails with the file-not-found code', async () => {
      const failure = daytonaError('not found', {code: 'FILE_NOT_FOUND'});
      sandbox.fs.downloadFile.mockRejectedValue(failure);

      await expect(env.readFile('missing.txt')).rejects.toMatchObject({
        message: 'File not found: /workspaces/missing.txt',
        cause: failure,
      });
    });

    it('rejects when the download fails with a 404', async () => {
      sandbox.fs.downloadFile.mockRejectedValue(
        daytonaError('not found', {statusCode: 404}),
      );

      await expect(env.readFile('missing.txt')).rejects.toThrow(
        'File not found: /workspaces/missing.txt',
      );
    });

    it('rethrows any other download failure unchanged', async () => {
      const failure = daytonaError('permission denied', {statusCode: 403});
      sandbox.fs.downloadFile.mockRejectedValue(failure);

      await expect(env.readFile('secret.txt')).rejects.toBe(failure);
    });

    it('rethrows a rejection that is not an object', async () => {
      sandbox.fs.downloadFile.mockRejectedValue('transport closed');

      await expect(env.readFile('notes.txt')).rejects.toBe('transport closed');
    });

    it('rethrows a rejection with no reason', async () => {
      sandbox.fs.downloadFile.mockRejectedValue(null);

      await expect(env.readFile('notes.txt')).rejects.toBeNull();
    });
  });

  describe('writeFile', () => {
    let env: DaytonaEnvironment;

    beforeEach(async () => {
      env = new DaytonaEnvironment();
      await env.initialize();
    });

    it('uploads string content as bytes to the resolved path', async () => {
      await env.writeFile('sub/out.txt', 'hello');

      expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
        Buffer.from('hello'),
        '/workspaces/sub/out.txt',
      );
      const [file] = sandbox.fs.uploadFile.mock.calls[0];
      expect(Buffer.isBuffer(file)).toBe(true);
      expect(sandbox.refreshActivity).toHaveBeenCalledTimes(1);
    });

    it('uploads raw bytes unchanged', async () => {
      const content = new TextEncoder().encode('raw bytes');

      await env.writeFile('out.bin', content);

      expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
        Buffer.from(content),
        '/workspaces/out.bin',
      );
    });

    it('creates every parent directory below the root, outermost first', async () => {
      await env.writeFile('sub/nested/file.txt', 'content');

      expect(sandbox.fs.createFolder.mock.calls).toEqual([
        ['/workspaces', '755'],
        ['/workspaces/sub', '755'],
        ['/workspaces/sub/nested', '755'],
      ]);
      expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
        Buffer.from('content'),
        '/workspaces/sub/nested/file.txt',
      );
    });

    it('creates no directory for a file at the sandbox root', async () => {
      await env.writeFile('/notes.txt', 'content');

      expect(sandbox.fs.createFolder).not.toHaveBeenCalled();
      expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
        Buffer.from('content'),
        '/notes.txt',
      );
    });

    it('ignores a directory that already exists, reported as a conflict', async () => {
      sandbox.fs.createFolder.mockRejectedValue(
        daytonaError('conflict', {statusCode: 409}),
      );

      await env.writeFile('sub/out.txt', 'hello');

      expect(sandbox.fs.uploadFile).toHaveBeenCalledTimes(1);
    });

    it('ignores a directory that already exists, reported by message', async () => {
      sandbox.fs.createFolder.mockRejectedValue(
        new Error('folder already exists'),
      );

      await env.writeFile('sub/out.txt', 'hello');

      expect(sandbox.fs.uploadFile).toHaveBeenCalledTimes(1);
    });

    it('rethrows any other directory failure and uploads nothing', async () => {
      const failure = daytonaError('permission denied', {statusCode: 403});
      sandbox.fs.createFolder.mockRejectedValue(failure);

      await expect(env.writeFile('sub/out.txt', 'hello')).rejects.toBe(failure);
      expect(sandbox.fs.uploadFile).not.toHaveBeenCalled();
    });
  });
});
