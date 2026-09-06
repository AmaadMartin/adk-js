/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `DaytonaEnvironment` behaviour the adk-python reference suite does not
 * cover, because the Python contract does not have it: byte writes, an
 * injected client, the error shapes only the TypeScript SDK raises, and the
 * failure paths of every method.
 */

import type {Daytona, DaytonaConfig} from '@daytona/sdk';
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

describe('DaytonaEnvironment', () => {
  let sandbox: FakeSandbox;
  let client: FakeClient;

  beforeEach(() => {
    sandbox = createFakeSandbox();
    client = createFakeClient(sandbox);
    DaytonaMock.mockReset();
    DaytonaMock.mockReturnValue(client);
  });

  describe('initialize', () => {
    it('rounds a sub-minute lifetime up to one auto-stop minute', async () => {
      const env = new DaytonaEnvironment({timeoutSeconds: 30});

      await env.initialize();

      expect(client.create.mock.calls[0][0]).toMatchObject({
        autoStopInterval: 1,
      });
    });

    it('leaves a zero lifetime as zero, which Daytona reads as never stop', async () => {
      const env = new DaytonaEnvironment({timeoutSeconds: 0});

      await env.initialize();

      expect(client.create.mock.calls[0][0]).toMatchObject({
        autoStopInterval: 0,
      });
    });

    it('sends empty environment variables when the caller gives none', async () => {
      const env = new DaytonaEnvironment();

      await env.initialize();

      expect(client.create.mock.calls[0][0]).toMatchObject({envVars: {}});
    });

    it('builds a fresh client after close', async () => {
      const env = new DaytonaEnvironment();
      await env.initialize();
      await env.close();

      await env.initialize();

      expect(DaytonaMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('close', () => {
    it('does nothing before initialize', async () => {
      const env = new DaytonaEnvironment();

      await env.close();

      expect(sandbox.delete).not.toHaveBeenCalled();
      expect(env.isInitialized).toBe(false);
    });

    it('leaves an injected client for its owner to dispose', async () => {
      // The mocked constructor hands back the fake, typed as the real client.
      const {Daytona} = await import('@daytona/sdk');
      const injected: Daytona = new Daytona();
      const env = new DaytonaEnvironment({client: injected});

      await env.initialize();
      await env.close();

      expect(DaytonaMock).toHaveBeenCalledTimes(1);
      expect(client.create).toHaveBeenCalledTimes(1);
      expect(sandbox.delete).toHaveBeenCalledTimes(1);
      expect(client[Symbol.asyncDispose]).not.toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('forwards the constructor timeout as whole seconds', async () => {
      const env = new DaytonaEnvironment({timeoutSeconds: 90});
      await env.initialize();

      await env.execute('echo hi');

      expect(sandbox.process.executeCommand).toHaveBeenCalledWith(
        'echo hi',
        undefined,
        undefined,
        90,
      );
    });

    it('truncates a fractional per-call timeout, which the SDK requires', async () => {
      const env = new DaytonaEnvironment();
      await env.initialize();

      await env.execute('echo hi', 12.7);

      expect(sandbox.process.executeCommand).toHaveBeenCalledWith(
        'echo hi',
        undefined,
        undefined,
        12,
      );
    });

    it('falls back to result when the daemon sends no artifacts', async () => {
      sandbox.process.executeCommand.mockResolvedValue({
        exitCode: 3,
        result: 'from result',
      });
      const env = new DaytonaEnvironment();
      await env.initialize();

      const result = await env.execute('echo hi');

      expect(result).toEqual({
        exitCode: 3,
        stdout: 'from result',
        stderr: '',
        timedOut: false,
      });
    });

    it('reports a timeout carrying the SDK process timeout code', async () => {
      sandbox.process.executeCommand.mockRejectedValue(
        createDaytonaError(
          'DaytonaProcessExecutionTimeoutError',
          'command did not finish',
          {code: 'PROCESS_EXECUTION_TIMEOUT'},
        ),
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

    it('rethrows a Daytona failure that is not a timeout', async () => {
      const failure = createDaytonaError(
        'DaytonaInternalServerError',
        'daemon exploded',
        {statusCode: 500},
      );
      sandbox.process.executeCommand.mockRejectedValue(failure);
      const env = new DaytonaEnvironment();
      await env.initialize();

      await expect(env.execute('echo hi')).rejects.toBe(failure);
    });

    it('rethrows a Daytona error carrying no message', async () => {
      const failure = {name: 'DaytonaError'};
      sandbox.process.executeCommand.mockRejectedValue(failure);
      const env = new DaytonaEnvironment();
      await env.initialize();

      await expect(env.execute('echo hi')).rejects.toBe(failure);
    });

    it('rethrows a rejection whose name is not a Daytona error class', async () => {
      const failure = new Error('socket hang up');
      sandbox.process.executeCommand.mockRejectedValue(failure);
      const env = new DaytonaEnvironment();
      await env.initialize();

      await expect(env.execute('echo hi')).rejects.toBe(failure);
    });

    it('rethrows a rejection that carries no name at all', async () => {
      sandbox.process.executeCommand.mockRejectedValue({status: 'gone'});
      const env = new DaytonaEnvironment();
      await env.initialize();

      await expect(env.execute('echo hi')).rejects.toEqual({status: 'gone'});
    });

    it('rethrows a rejection that is not an object', async () => {
      sandbox.process.executeCommand.mockRejectedValue('socket hang up');
      const env = new DaytonaEnvironment();
      await env.initialize();

      await expect(env.execute('echo hi')).rejects.toBe('socket hang up');
    });
  });

  describe('readFile', () => {
    it('rejects before initialize', async () => {
      const env = new DaytonaEnvironment();

      await expect(env.readFile('notes.txt')).rejects.toThrow(
        'Sandbox is not started. Call initialize() first.',
      );
    });

    it('reports ENOENT for the SDK file-not-found code', async () => {
      const notFound = createDaytonaError(
        'DaytonaFileNotFoundError',
        'no such file',
        {code: 'FILE_NOT_FOUND'},
      );
      sandbox.fs.downloadFile.mockRejectedValue(notFound);
      const env = new DaytonaEnvironment();
      await env.initialize();

      await expect(env.readFile('missing.txt')).rejects.toMatchObject({
        code: 'ENOENT',
        cause: notFound,
      });
    });

    it('reports ENOENT for an HTTP 404 from the daemon', async () => {
      sandbox.fs.downloadFile.mockRejectedValue(
        createDaytonaError('DaytonaError', 'gone', {statusCode: 404}),
      );
      const env = new DaytonaEnvironment();
      await env.initialize();

      await expect(env.readFile('missing.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('rethrows a download failure that is not a missing file', async () => {
      const failure = createDaytonaError('DaytonaForbiddenError', 'denied', {
        statusCode: 403,
      });
      sandbox.fs.downloadFile.mockRejectedValue(failure);
      const env = new DaytonaEnvironment();
      await env.initialize();

      await expect(env.readFile('secret.txt')).rejects.toBe(failure);
    });

    it('rethrows a download failure that did not come from the SDK', async () => {
      const failure = new Error('socket hang up');
      sandbox.fs.downloadFile.mockRejectedValue(failure);
      const env = new DaytonaEnvironment();
      await env.initialize();

      await expect(env.readFile('notes.txt')).rejects.toBe(failure);
    });
  });

  describe('writeFile', () => {
    it('rejects before initialize', async () => {
      const env = new DaytonaEnvironment();

      await expect(env.writeFile('out.txt', 'hello')).rejects.toThrow(
        'Sandbox is not started. Call initialize() first.',
      );
    });

    it('uploads raw bytes unchanged', async () => {
      const bytes = new Uint8Array([0, 159, 146, 150]);
      const env = new DaytonaEnvironment();
      await env.initialize();

      await env.writeFile('blob.bin', bytes);

      expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
        Buffer.from(bytes),
        '/workspaces/blob.bin',
      );
    });

    it('creates no folder for a file sitting at the filesystem root', async () => {
      const env = new DaytonaEnvironment();
      await env.initialize();

      await env.writeFile('/out.txt', 'hello');

      expect(sandbox.fs.createFolder).not.toHaveBeenCalled();
      expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
        Buffer.from('hello', 'utf-8'),
        '/out.txt',
      );
    });

    it('uploads even when creating a parent directory fails', async () => {
      sandbox.fs.createFolder.mockRejectedValue(
        createDaytonaError('DaytonaConflictError', 'already exists', {
          statusCode: 409,
        }),
      );
      const env = new DaytonaEnvironment();
      await env.initialize();

      await env.writeFile('sub/out.txt', 'hello');

      expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(
        Buffer.from('hello', 'utf-8'),
        '/workspaces/sub/out.txt',
      );
    });
  });
});
