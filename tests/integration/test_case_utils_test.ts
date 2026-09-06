/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {BaseTestServer} from './test_case_utils.js';

const START_MESSAGE = 'READY';
const SERVER_NAME = 'Fake';
const DEFAULT_TIMEOUT_MS = 15000;
/** Distinctive value so the watchdog is identifiable among all setTimeout calls. */
const WATCHDOG_TIMEOUT_MS = 12345;
/** Port handed to the constructor, so a read-back is visible as a change. */
const CONSTRUCTOR_PORT = 19999;

/** Overrides a {@link FakeServer} applies to its start handshake. */
interface FakeServerOptions {
  startMessage?: string;
  timeoutMs?: number;
}

/** Keeps a `node -e` child alive until the test kills it. */
const KEEP_ALIVE = 'setTimeout(() => {}, 60000);';

/** A `node -e` statement that writes one line to stdout. */
function writeLine(line: string): string {
  return `process.stdout.write(${JSON.stringify(`${line}\n`)});`;
}

/** `node -e` source that writes the given lines to stdout, then idles. */
function serverScript(...lines: string[]): string {
  return `${lines.map(writeLine).join('')}${KEEP_ALIVE}`;
}

/**
 * Minimal {@link BaseTestServer} driven by a hermetic `node -e` child, so the
 * start handshake can be exercised without a real server.
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
        this.child = spawn(process.execPath, ['-e', this.script]);
        return this.child;
      },
      startMessage: this.options.startMessage ?? START_MESSAGE,
      successLogMessage: 'fake server started',
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

describe('BaseTestServer.startProcess', () => {
  const servers: FakeServer[] = [];
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  function createServer(
    script: string,
    options?: FakeServerOptions,
  ): FakeServer {
    const server = new FakeServer(script, options);
    servers.push(server);
    return server;
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) {
      await server.stop();
    }
  });

  it('clears the start-up watchdog once the server reports success', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const server = createServer(serverScript(START_MESSAGE), {
      timeoutMs: WATCHDOG_TIMEOUT_MS,
    });

    await server.start();

    const watchdogIndex = setTimeoutSpy.mock.calls.findIndex(
      ([, delay]) => delay === WATCHDOG_TIMEOUT_MS,
    );
    expect(watchdogIndex).toBeGreaterThanOrEqual(0);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(
      setTimeoutSpy.mock.results[watchdogIndex].value,
    );
  });

  it('detaches the start-up listeners once the server reports success', async () => {
    const server = createServer(serverScript(START_MESSAGE));

    await server.start();

    const child = server.childProcess;
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.stdout.isPaused()).toBe(false);
    // Deliberately retained: an unhandled 'error' event would crash the worker
    // and stderr needs a draining consumer.
    expect(child.listenerCount('error')).toBe(1);
    expect(child.stderr.listenerCount('data')).toBe(1);
  });

  it('does not log an exit message when the server is stopped cleanly', async () => {
    const server = createServer(serverScript(START_MESSAGE));
    await server.start();
    const child = server.childProcess;
    const exited = once(child, 'exit');

    await server.stop();
    await exited;

    const logged = consoleErrorSpy.mock.calls.flat().join('\n');
    expect(logged).not.toMatch(/exited with code/);
    // A clean shutdown must not reach the premature-exit diagnostic either.
    expect(logged).toBe('');
  });

  it('ignores URLs printed after start-up', async () => {
    const server = createServer(
      `${writeLine('http://localhost:41111')}${writeLine(START_MESSAGE)}` +
        `setTimeout(() => {${writeLine('http://localhost:49999')}}, 50);` +
        KEEP_ALIVE,
    );

    await server.start();
    await waitForStdout(server.childProcess, '49999');

    expect(server.port).toBe(41111);
    expect(server.url).toBe('http://localhost:41111');
  });

  it.each([
    'http://localhost:41234',
    'http://127.0.0.1:41234',
    'http://[::1]:41234',
  ])('reads the port back from the start-up banner %s', async (banner) => {
    const server = createServer(
      serverScript(`A2A Server started on ${banner}`),
      {startMessage: 'A2A Server started on'},
    );

    await server.start();

    expect(server.port).toBe(41234);
    expect(server.url).toBe('http://localhost:41234');
  });

  it('rejects and releases the handshake when the server never starts', async () => {
    const server = createServer(KEEP_ALIVE, {timeoutMs: 200});

    await expect(server.start()).rejects.toThrow(
      'Timeout waiting for fake to start.',
    );

    const child = server.childProcess;
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('rejects with the captured stdout when the server exits prematurely', async () => {
    const server = createServer(
      `process.stdout.write(${JSON.stringify('boot log line\n')}, () => process.exit(3));`,
    );

    await expect(server.start()).rejects.toThrow(
      'Fake exited prematurely with code 3',
    );

    const logged = consoleErrorSpy.mock.calls.flat().join('\n');
    expect(logged).toContain('boot log line');
  });
});
