/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import type {MockInstance} from 'vitest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {BaseTestServer} from './test_case_utils.js';

const SERVER_NAME = 'Fake';
const START_MESSAGE = 'READY';
const SUCCESS_LOG_MESSAGE = 'fake server started';
const DEFAULT_TIMEOUT_MS = 15000;

/** Distinctive delay, so the watchdog is identifiable among all timers. */
const WATCHDOG_TIMEOUT_MS = 12345;

/** Mirrors the private STOP_EXIT_TIMEOUT_MS in test_case_utils.ts. */
const STOP_FALLBACK_TIMEOUT_MS = 500;

/** Port given to the constructor, so a banner read-back is visible. */
const CONSTRUCTOR_PORT = 19999;

/** Port printed in the start-up banner. */
const BANNER_PORT = 41111;

/** Port printed after the handshake, which the server must ignore. */
const LATE_PORT = 49999;

/** Keeps a `node -e` child alive until the test kills it. */
const KEEP_ALIVE = 'setTimeout(() => {}, 60000);';

/** Overrides a {@link FakeServer} applies to its start handshake. */
interface FakeServerOptions {
  command?: string;
  timeoutMs?: number;
}

/** A `node -e` statement that writes one line to stdout. */
function writeLine(line: string): string {
  return `process.stdout.write(${JSON.stringify(`${line}\n`)});`;
}

/** `node -e` source that writes the given lines to stdout, then idles. */
function serverScript(...lines: string[]): string {
  return `${lines.map(writeLine).join('')}${KEEP_ALIVE}`;
}

/**
 * Minimal {@link BaseTestServer} backed by a hermetic `node -e` child, so the
 * start handshake and the teardown can be exercised without a real server.
 */
class FakeServer extends BaseTestServer {
  private child?: ChildProcessWithoutNullStreams;

  constructor(
    private readonly script: string,
    private readonly options: FakeServerOptions = {},
  ) {
    super('localhost', CONSTRUCTOR_PORT);
  }

  async start(): Promise<void> {
    await this.startProcess({
      spawnProcess: () => {
        this.child = spawn(this.options.command ?? process.execPath, [
          '-e',
          this.script,
        ]);
        return this.child;
      },
      startMessage: START_MESSAGE,
      successLogMessage: SUCCESS_LOG_MESSAGE,
      serverName: SERVER_NAME,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }

  get childProcess(): ChildProcessWithoutNullStreams {
    if (!this.child) {
      expect.fail('the fake server was never spawned');
    }
    return this.child;
  }

  /** Teardown backstop for a child that outlives {@link BaseTestServer.stop}. */
  forceKill(): void {
    this.child?.kill('SIGKILL');
  }
}

/** Resolves once `needle` has been seen on the child's stdout. */
function waitForStdout(
  child: ChildProcessWithoutNullStreams,
  needle: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let output = '';
    const onData = (data: Buffer) => {
      output += data.toString();
      if (output.includes(needle)) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
  });
}

/** The timer handle returned by the `setTimeout` call armed with `delay`. */
function timerArmedWith(
  setTimeoutSpy: MockInstance<typeof globalThis.setTimeout>,
  delay: number,
  fromCall = 0,
): ReturnType<typeof setTimeout> {
  const index = setTimeoutSpy.mock.calls.findIndex(
    ([, armedDelay], call) => call >= fromCall && armedDelay === delay,
  );
  if (index < 0) {
    expect.fail(`no setTimeout call was armed with ${delay} ms`);
  }
  const result = setTimeoutSpy.mock.results[index];
  if (result.type !== 'return') {
    expect.fail(`the setTimeout call armed with ${delay} ms threw`);
  }
  return result.value;
}

describe('BaseTestServer', () => {
  const servers: FakeServer[] = [];
  const consoleErrors: string[] = [];

  function createServer(
    script: string,
    options?: FakeServerOptions,
  ): FakeServer {
    const server = new FakeServer(script, options);
    servers.push(server);
    return server;
  }

  beforeEach(() => {
    consoleErrors.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.join(' '));
    });
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.stop();
      server.forceKill();
    }
    vi.restoreAllMocks();
  });

  describe('startProcess', () => {
    it('clears the start-up watchdog once the server reports success', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const server = createServer(serverScript(START_MESSAGE), {
        timeoutMs: WATCHDOG_TIMEOUT_MS,
      });

      await server.start();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(
        timerArmedWith(setTimeoutSpy, WATCHDOG_TIMEOUT_MS),
      );
    });

    it('detaches the handshake listeners once the server reports success', async () => {
      const server = createServer(serverScript(START_MESSAGE));

      await server.start();

      const child = server.childProcess;
      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
      // Detaching must not pause stdout, or the child blocks on a full pipe.
      expect(child.stdout.isPaused()).toBe(false);
      // Deliberately retained: an unhandled 'error' event would crash the
      // worker, and stderr needs a draining consumer.
      expect(child.listenerCount('error')).toBe(1);
      expect(child.stderr.listenerCount('data')).toBe(1);
    });

    it('ignores a URL the server prints after the handshake', async () => {
      const server = createServer(
        `${writeLine(`http://localhost:${BANNER_PORT}`)}` +
          `${writeLine(START_MESSAGE)}` +
          `setTimeout(() => {${writeLine(`http://localhost:${LATE_PORT}`)}}, 50);` +
          KEEP_ALIVE,
      );

      await server.start();
      await waitForStdout(server.childProcess, String(LATE_PORT));

      expect(server.port).toBe(BANNER_PORT);
      expect(server.url).toBe(`http://localhost:${BANNER_PORT}`);
    });

    it('releases the handshake when the server never starts', async () => {
      const server = createServer(KEEP_ALIVE, {timeoutMs: 200});

      await expect(server.start()).rejects.toThrow(
        'Timeout waiting for fake to start.',
      );

      const child = server.childProcess;
      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
    });

    it('releases the handshake when the server exits before the banner', async () => {
      const server = createServer(
        `process.stdout.write(${JSON.stringify('boot log line\n')}, () => process.exit(3));`,
      );

      await expect(server.start()).rejects.toThrow(
        'Fake exited prematurely with code 3',
      );

      const child = server.childProcess;
      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
      const logged = consoleErrors.join('\n');
      expect(logged).toContain('Fake exited with code 3');
      expect(logged).toContain('Captured stdout before premature exit');
    });

    it('releases the handshake when the server cannot be spawned', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const server = createServer(KEEP_ALIVE, {
        command: 'adk-js-no-such-binary',
        timeoutMs: WATCHDOG_TIMEOUT_MS,
      });

      await expect(server.start()).rejects.toThrow('Failed to start fake:');

      const child = server.childProcess;
      expect(child.stdout.listenerCount('data')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(
        timerArmedWith(setTimeoutSpy, WATCHDOG_TIMEOUT_MS),
      );
    });
  });

  describe('stop', () => {
    it('logs no exit message for a clean shutdown', async () => {
      const server = createServer(serverScript(START_MESSAGE));
      await server.start();
      const exited = once(server.childProcess, 'exit');

      await server.stop();
      await exited;

      expect(consoleErrors.join('\n')).not.toContain('exited with code');
    });

    it('returns as soon as the child exits', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const server = createServer(serverScript(START_MESSAGE));
      await server.start();
      const child = server.childProcess;
      const callsBeforeStop = setTimeoutSpy.mock.calls.length;

      const startedAt = Date.now();
      await server.stop();

      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(
        timerArmedWith(
          setTimeoutSpy,
          STOP_FALLBACK_TIMEOUT_MS,
          callsBeforeStop,
        ),
      );
      expect(child.listenerCount('exit')).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(450);
    });

    // Windows has no real SIGINT: Node terminates the child unconditionally,
    // so a child cannot survive the kill there and the fallback never runs.
    it.skipIf(process.platform === 'win32')(
      'gives up after the bounded fallback when the child ignores SIGINT',
      async () => {
        const server = createServer(
          `process.on('SIGINT', () => {});${writeLine(START_MESSAGE)}${KEEP_ALIVE}`,
        );
        await server.start();
        const child = server.childProcess;

        await server.stop();

        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect(child.listenerCount('exit')).toBe(0);
      },
    );

    it('is a no-op for a child that already exited', async () => {
      const server = createServer(serverScript(START_MESSAGE));
      await server.start();
      const child = server.childProcess;
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      await expect(server.stop()).resolves.toBeUndefined();

      expect(
        setTimeoutSpy.mock.calls.some(
          ([, delay]) => delay === STOP_FALLBACK_TIMEOUT_MS,
        ),
      ).toBe(false);
    });

    it('is a no-op for a server that never started', async () => {
      const server = createServer(serverScript(START_MESSAGE));

      await expect(server.stop()).resolves.toBeUndefined();
    });
  });
});
