/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour of `DaytonaEnvironment` that the adk-python reference suite does
 * not cover: the timeout arithmetic, the error classification, and the
 * teardown on each failure path.
 */

import {DaytonaEnvironment} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  clients,
  currentSandbox,
  DaytonaConflictError,
  DaytonaError,
  DaytonaTimeoutError,
  failCreate,
  resetFakeDaytona,
} from './fake_daytona.js';

vi.mock('@daytona/sdk', () => import('./fake_daytona.js'));

/** Builds an initialized environment over the current fake sandbox. */
async function initialized(
  timeoutSeconds?: number,
): Promise<DaytonaEnvironment> {
  const env = new DaytonaEnvironment(
    timeoutSeconds === undefined ? {} : {timeoutSeconds},
  );
  await env.initialize();
  return env;
}

describe('DaytonaEnvironment.execute', () => {
  beforeEach(() => {
    resetFakeDaytona();
    currentSandbox().process.executeCommand.mockResolvedValue({
      exitCode: 0,
      result: '',
    });
  });

  it('passes the per-call timeout instead of the constructor default', async () => {
    const env = await initialized(300);

    await env.execute('echo hi', 12);

    expect(currentSandbox().process.executeCommand).toHaveBeenCalledWith(
      'echo hi',
      undefined,
      undefined,
      12,
    );
  });

  it('passes the constructor timeout when the call gives none', async () => {
    const env = await initialized(45);

    await env.execute('echo hi');

    expect(currentSandbox().process.executeCommand).toHaveBeenCalledWith(
      'echo hi',
      undefined,
      undefined,
      45,
    );
  });

  it('truncates a fractional timeout, which Daytona takes in whole seconds', async () => {
    const env = await initialized();

    await env.execute('echo hi', 1.9);

    expect(currentSandbox().process.executeCommand).toHaveBeenCalledWith(
      'echo hi',
      undefined,
      undefined,
      1,
    );
  });

  it('reports a non-zero exit code as a result rather than throwing', async () => {
    currentSandbox().process.executeCommand.mockResolvedValue({
      exitCode: 2,
      result: 'boom',
    });
    const env = await initialized();

    await expect(env.execute('false')).resolves.toEqual({
      exitCode: 2,
      stdout: 'boom',
      stderr: '',
      timedOut: false,
    });
  });

  it('falls back to `result` when the response carries no artifacts', async () => {
    currentSandbox().process.executeCommand.mockResolvedValue({
      exitCode: 0,
      result: 'from result',
    });
    const env = await initialized();

    await expect(env.execute('echo hi')).resolves.toMatchObject({
      stdout: 'from result',
    });
  });

  it('prefers the artifact stdout over `result`', async () => {
    currentSandbox().process.executeCommand.mockResolvedValue({
      exitCode: 0,
      result: 'from result',
      artifacts: {stdout: 'from artifacts'},
    });
    const env = await initialized();

    await expect(env.execute('echo hi')).resolves.toMatchObject({
      stdout: 'from artifacts',
    });
  });

  it('reports a DaytonaTimeoutError as a timed-out result', async () => {
    currentSandbox().process.executeCommand.mockRejectedValue(
      new DaytonaTimeoutError('deadline exceeded'),
    );
    const env = await initialized();

    await expect(env.execute('sleep 999')).resolves.toMatchObject({
      exitCode: -1,
      timedOut: true,
    });
  });

  it('propagates a Daytona error that is not a timeout', async () => {
    const failure = new DaytonaError('sandbox is stopped');
    currentSandbox().process.executeCommand.mockRejectedValue(failure);
    const env = await initialized();

    await expect(env.execute('echo hi')).rejects.toBe(failure);
  });
});

describe('DaytonaEnvironment sandbox creation', () => {
  beforeEach(() => {
    resetFakeDaytona();
  });

  it.each([
    [300, 5],
    [120, 2],
    [59, 1],
    [30, 1],
    [0, 0],
  ])(
    'turns a %i second lifetime into a %i minute auto-stop interval',
    async (timeoutSeconds, minutes) => {
      await initialized(timeoutSeconds);

      expect(clients[0].create).toHaveBeenCalledWith(
        expect.objectContaining({autoStopInterval: minutes}),
      );
    },
  );

  it('releases the client when the sandbox cannot be created', async () => {
    const failure = new DaytonaError('no capacity');
    failCreate(failure);
    const env = new DaytonaEnvironment();

    await expect(env.initialize()).rejects.toBe(failure);

    expect(clients[0].dispose).toHaveBeenCalledOnce();
    expect(env.isInitialized).toBe(false);
  });

  it('reports the sandbox working directory once initialized', async () => {
    const env = await initialized();

    expect(env.workingDir).toBe('/workspaces');
  });
});

describe('DaytonaEnvironment.close', () => {
  beforeEach(() => {
    resetFakeDaytona();
  });

  it('releases the client even when deleting the sandbox fails', async () => {
    const failure = new DaytonaError('sandbox is gone');
    const env = await initialized();
    currentSandbox().delete.mockRejectedValue(failure);

    await expect(env.close()).rejects.toBe(failure);

    expect(clients[0].dispose).toHaveBeenCalledOnce();
    expect(env.isInitialized).toBe(false);
  });
});

describe('DaytonaEnvironment.readFile', () => {
  beforeEach(() => {
    resetFakeDaytona();
  });

  it('reports a 404 from a second copy of the SDK as a missing file', async () => {
    // The error class comes from another module instance, so `instanceof`
    // fails and only the status code identifies it.
    const failure = Object.assign(new Error('no such file'), {
      statusCode: 404,
    });
    currentSandbox().fs.downloadFile.mockRejectedValue(failure);
    const env = await initialized();

    await expect(env.readFile('missing.txt')).rejects.toThrow(
      'File not found: /workspaces/missing.txt',
    );
  });

  it('propagates a download failure that is not a missing file', async () => {
    const failure = {message: 'connection reset'};
    currentSandbox().fs.downloadFile.mockRejectedValue(failure);
    const env = await initialized();

    await expect(env.readFile('notes.txt')).rejects.toBe(failure);
  });
});

describe('DaytonaEnvironment.writeFile', () => {
  beforeEach(() => {
    resetFakeDaytona();
  });

  it('uploads the exact bytes of a Uint8Array', async () => {
    const env = await initialized();
    const content = new Uint8Array([0, 1, 254, 255]);

    await env.writeFile('raw.bin', content);

    expect(currentSandbox().fs.uploadFile).toHaveBeenCalledWith(
      Buffer.from(content),
      '/workspaces/raw.bin',
    );
  });

  it.each([
    ['a conflict error', new DaytonaConflictError('nope')],
    ['a 409 status', Object.assign(new Error('nope'), {statusCode: 409})],
    ['an "already exists" message', new Error('Folder already exists')],
  ])(
    'continues past %s from createFolder and still uploads',
    async (_label, failure) => {
      currentSandbox().fs.createFolder.mockRejectedValue(failure);
      const env = await initialized();

      await env.writeFile('sub/out.txt', 'hello');

      expect(currentSandbox().fs.uploadFile).toHaveBeenCalledWith(
        Buffer.from('hello'),
        '/workspaces/sub/out.txt',
      );
    },
  );

  it('rethrows a createFolder failure that is not a conflict', async () => {
    const failure = new DaytonaError('permission denied');
    currentSandbox().fs.createFolder.mockRejectedValue(failure);
    const env = await initialized();

    await expect(env.writeFile('sub/out.txt', 'hello')).rejects.toBe(failure);
    expect(currentSandbox().fs.uploadFile).not.toHaveBeenCalled();
  });

  it('creates no directory for a file at the filesystem root', async () => {
    const env = await initialized();

    await env.writeFile('/out.txt', 'hello');

    expect(currentSandbox().fs.createFolder).not.toHaveBeenCalled();
    expect(currentSandbox().fs.uploadFile).toHaveBeenCalledWith(
      Buffer.from('hello'),
      '/out.txt',
    );
  });
});
