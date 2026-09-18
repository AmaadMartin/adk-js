/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour this port adds on top of the reference suite: the optional-peer
 * load, the seconds-to-milliseconds conversion, byte writes, and the error
 * paths adk-python's suite does not reach.
 *
 * The ported reference tests live in `e2b_environment_test.ts`.
 */

import {E2BEnvironment} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  commandResult,
  createFakeSandbox,
  namedError,
  type FakeSandbox,
} from './e2b_test_fakes.js';

const {sandboxCreate, loadPeer} = vi.hoisted(() => ({
  sandboxCreate: vi.fn(),
  loadPeer:
    vi.fn<
      (
        peer: {packageName: string; feature: string},
        load: () => Promise<unknown>,
      ) => Promise<unknown>
    >(),
}));

vi.mock('e2b', () => ({Sandbox: {create: sandboxCreate}}));

// Vitest replaces an error thrown from a `vi.mock` factory with one of its
// own, so a real `ERR_MODULE_NOT_FOUND` cannot be staged on the `e2b` mock.
// Spy on the shared loader instead: `optional_peer_test.ts` already pins the
// translation from that code to the actionable message, so asserting the
// exact descriptor here is what proves E2BEnvironment gets it.
vi.mock('../../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/utils/optional_peer.js')
    >();
  loadPeer.mockImplementation(actual.loadOptionalPeer);
  return {loadOptionalPeer: loadPeer};
});

describe('E2BEnvironment', () => {
  let sandbox: FakeSandbox;

  beforeEach(() => {
    vi.clearAllMocks();
    sandbox = createFakeSandbox();
    sandboxCreate.mockResolvedValue(sandbox);
  });

  describe('loading the optional peer dependency', () => {
    it('asks the shared loader for e2b, naming E2BEnvironment', async () => {
      await new E2BEnvironment().initialize();

      expect(loadPeer).toHaveBeenCalledWith(
        {packageName: 'e2b', feature: 'E2BEnvironment'},
        expect.any(Function),
      );
      // The thunk resolved the mocked `e2b`, so the specifier is that literal.
      expect(sandboxCreate).toHaveBeenCalledTimes(1);
    });

    it('propagates the loader error and stays uninitialized', async () => {
      const notInstalled = new Error('e2b is not installed');
      loadPeer.mockRejectedValueOnce(notInstalled);
      const env = new E2BEnvironment();

      await expect(env.initialize()).rejects.toBe(notInstalled);

      expect(env.isInitialized).toBe(false);
      // The failed attempt must not latch: a retry still creates a sandbox.
      await env.initialize();
      expect(env.isInitialized).toBe(true);
    });
  });

  describe('sandbox creation', () => {
    it('applies the default image and time-to-live', async () => {
      await new E2BEnvironment().initialize();

      expect(sandboxCreate).toHaveBeenCalledWith(
        expect.objectContaining({template: 'base', timeoutMs: 300_000}),
      );
    });

    it('passes the api key through to the sdk', async () => {
      await new E2BEnvironment({apiKey: 'test-key'}).initialize();

      expect(sandboxCreate).toHaveBeenCalledWith(
        expect.objectContaining({apiKey: 'test-key'}),
      );
    });
  });

  describe('execute', () => {
    it('converts an explicit timeout from seconds to milliseconds', async () => {
      const env = new E2BEnvironment();
      await env.initialize();

      await env.execute('sleep 1', 5);

      expect(sandbox.commands.run).toHaveBeenCalledWith(
        'sleep 1',
        expect.objectContaining({timeoutMs: 5_000}),
      );
    });

    it('bounds a command with no timeout by the sandbox time-to-live', async () => {
      const env = new E2BEnvironment({timeoutSeconds: 42});
      await env.initialize();

      await env.execute('x');

      expect(sandbox.commands.run).toHaveBeenCalledWith(
        'x',
        expect.objectContaining({timeoutMs: 42_000}),
      );
    });

    it('runs the command in the working directory', async () => {
      const env = new E2BEnvironment();
      await env.initialize();

      await env.execute('pwd');

      expect(sandbox.commands.run).toHaveBeenCalledWith(
        'pwd',
        expect.objectContaining({cwd: env.workingDir}),
      );
    });

    it('propagates an unrecognised sdk error', async () => {
      const unknownError = namedError('RateLimitError', 'slow down');
      sandbox.commands.run.mockRejectedValue(unknownError);
      const env = new E2BEnvironment();
      await env.initialize();

      await expect(env.execute('x')).rejects.toBe(unknownError);
    });

    it('extends the time-to-live', async () => {
      sandbox.commands.run.mockResolvedValue(commandResult({}));
      const env = new E2BEnvironment({timeoutSeconds: 30});
      await env.initialize();

      await env.execute('x');

      expect(sandbox.setTimeout).toHaveBeenCalledWith(30_000);
    });
  });

  describe('readFile', () => {
    it('propagates an unrecognised sdk error', async () => {
      const unknownError = namedError('NotEnoughSpaceError', 'disk full');
      sandbox.files.read.mockRejectedValue(unknownError);
      const env = new E2BEnvironment();
      await env.initialize();

      await expect(env.readFile('a.txt')).rejects.toBe(unknownError);
    });
  });

  describe('writeFile', () => {
    it('wraps bytes in a blob that round-trips', async () => {
      const bytes = new Uint8Array([1, 2, 3, 255]);
      const env = new E2BEnvironment();
      await env.initialize();

      await env.writeFile('bin.dat', bytes);

      const [path, data] = sandbox.files.write.mock.calls[0];
      expect(path).toBe('/home/user/bin.dat');
      expect(data).toBeInstanceOf(Blob);
      if (!(data instanceof Blob)) {
        expect.fail('expected a Blob');
      }
      expect(new Uint8Array(await data.arrayBuffer())).toEqual(bytes);
    });

    it('extends the time-to-live', async () => {
      const env = new E2BEnvironment({timeoutSeconds: 30});
      await env.initialize();

      await env.writeFile('a.txt', 'x');

      expect(sandbox.setTimeout).toHaveBeenCalledWith(30_000);
    });
  });

  describe('lifecycle', () => {
    it('reports the sandbox home as the working directory', async () => {
      const env = new E2BEnvironment();
      await env.initialize();

      expect(env.workingDir).toBe('/home/user');
    });

    it('closing before initialize is a no-op', async () => {
      const env = new E2BEnvironment();

      await expect(env.close()).resolves.toBeUndefined();

      expect(sandbox.kill).not.toHaveBeenCalled();
      expect(env.isInitialized).toBe(false);
    });

    it('rejects writeFile before initialize', async () => {
      const env = new E2BEnvironment();

      await expect(env.writeFile('a.txt', 'x')).rejects.toThrow(
        'Sandbox is not started',
      );
    });

    it('rejects readFile before initialize', async () => {
      const env = new E2BEnvironment();

      await expect(env.readFile('a.txt')).rejects.toThrow(
        'Sandbox is not started',
      );
    });
  });
});
