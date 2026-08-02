/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync} from 'node:fs';
import {createServer, type Server} from 'node:net';
import {platform, tmpdir} from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {BaseTestServer, reserveFreePort} from './test_case_utils.js';

const HOST = 'localhost';
const START_MESSAGE = 'SCRIPTED SERVER STARTED';
/** Comfortably longer than a `node -e` child needs to print its banner. */
const START_TIMEOUT_MS = 15000;
/** Keeps a scripted child alive until the test tears it down. */
const STAY_ALIVE = 'setInterval(() => {}, 1000);';
/** Mirrors `PROCESS_EXIT_TIMEOUT_MS` in the harness under test. */
const PROCESS_EXIT_TIMEOUT_MS = 5000;
const IS_WINDOWS = platform() === 'win32';

const spawned: ChildProcessWithoutNullStreams[] = [];
const listeners: Server[] = [];
/** Files holding the pid of a grandchild that teardown must reap. */
const grandchildPidFiles: string[] = [];

/** Spawns a `node -e` child; portable and needs no shell quoting. */
function nodeScript(script: string): () => ChildProcessWithoutNullStreams {
  return () => {
    const child = spawn(process.execPath, ['-e', script]);
    spawned.push(child);
    return child;
  };
}

/**
 * A {@link BaseTestServer} driven by a `node -e` script instead of the built
 * ADK CLI, so the harness itself can be tested without a build.
 */
class ScriptedTestServer extends BaseTestServer {
  child?: ChildProcessWithoutNullStreams;
  /** `this.port` as observed from inside the spawn closure. */
  portAtSpawn = 0;

  constructor(
    private readonly spawnChild: () => ChildProcessWithoutNullStreams,
    port?: number,
  ) {
    super(HOST, port);
  }

  start(timeoutMs = START_TIMEOUT_MS): Promise<void> {
    return this.startProcess({
      spawnProcess: () => {
        this.portAtSpawn = this.port;
        this.child = this.spawnChild();
        return this.child;
      },
      startMessage: START_MESSAGE,
      serverName: 'Scripted',
      timeoutMs,
    });
  }
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Waits for the harness to reach its spawn closure. `startProcess` awaits the
 * port reservation first, so the child handle is not available synchronously.
 */
async function waitForChild(
  server: ScriptedTestServer,
): Promise<ChildProcessWithoutNullStreams> {
  for (let i = 0; i < 500 && !server.child; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!server.child) {
    expect.fail('the server never reached its spawn closure');
  }
  return server.child;
}

/** True for the Node error raised when a pid no longer exists. */
function isNoSuchProcess(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code === 'ESRCH'
  );
}

/** Binds `port` for the rest of the test, proving it was bindable. */
function listenOn(port: number): Promise<void> {
  const socket = createServer();
  listeners.push(socket);

  return new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen({host: HOST, port}, () => resolve());
  });
}

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    child.kill('SIGKILL');
  }
  for (const pidFile of grandchildPidFiles.splice(0)) {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    } catch (error: unknown) {
      // Windows tears the grandchild down with its parent, so by here it is
      // already gone. Any other failure is real and must surface.
      if (!isNoSuchProcess(error)) throw error;
    }
  }
  await Promise.all(
    listeners
      .splice(0)
      .map(
        (socket) =>
          new Promise<void>((resolve) => socket.close(() => resolve())),
      ),
  );
});

describe('reserveFreePort', () => {
  it('returns a port that can immediately be bound', async () => {
    const port = await reserveFreePort(HOST);

    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    await expect(listenOn(port)).resolves.toBeUndefined();
  });

  it('never hands back a port that is currently bound', async () => {
    const held = await reserveFreePort(HOST);
    await listenOn(held);

    for (let i = 0; i < 20; i++) {
      expect(await reserveFreePort(HOST)).not.toBe(held);
    }
  });

  it('rejects when the probe socket cannot bind the host', async () => {
    await expect(reserveFreePort('256.256.256.256')).rejects.toThrow();
  });
});

describe('BaseTestServer.startProcess', () => {
  it('reserves the port before the child is spawned', async () => {
    const server = new ScriptedTestServer(
      nodeScript(`process.stdout.write('${START_MESSAGE}\\n');${STAY_ALIVE}`),
    );

    await server.start();

    // The child reads `this.port` for --port and TEST_API_SERVER_PORT, so a
    // port assigned after the spawn would be silently ignored.
    expect(server.portAtSpawn).toBeGreaterThan(0);
    expect(server.portAtSpawn).toBe(server.port);
    expect(server.url).toBe(`http://${HOST}:${server.port}`);
  });

  it('honours an explicitly requested port instead of reserving one', async () => {
    const requested = await reserveFreePort(HOST);
    const server = new ScriptedTestServer(
      nodeScript(`process.stdout.write('${START_MESSAGE}\\n');${STAY_ALIVE}`),
      requested,
    );

    await server.start();

    expect(server.portAtSpawn).toBe(requested);
    expect(server.port).toBe(requested);
  });

  it('completes the handshake when the banner is split across writes', async () => {
    const [head, tail] = [START_MESSAGE.slice(0, 9), START_MESSAGE.slice(9)];
    const server = new ScriptedTestServer(
      nodeScript(
        `process.stdout.write('${head}');` +
          `setTimeout(() => process.stdout.write('${tail}\\n'), 50);` +
          STAY_ALIVE,
      ),
    );

    await expect(server.start()).resolves.toBeUndefined();
  });

  it('surfaces both captured streams when the child exits prematurely', async () => {
    const server = new ScriptedTestServer(
      nodeScript(
        "process.stderr.write('STDERR-REASON\\n', () => " +
          "process.stdout.write('STDOUT-REASON\\n', () => process.exit(1)));",
      ),
    );

    const attempt = server.start();

    await expect(attempt).rejects.toThrow(
      'Scripted exited prematurely with code 1',
    );
    await expect(attempt).rejects.toThrow('STDERR-REASON');
    await expect(attempt).rejects.toThrow('STDOUT-REASON');
  });

  it('reports both streams as empty when the child exits silently', async () => {
    const server = new ScriptedTestServer(nodeScript('process.exit(1);'));

    const error = await server.start().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      expect.fail('expected start() to reject with an Error');
    }
    expect(error.message).toContain('stdout:\n(no output captured)');
    expect(error.message).toContain('stderr:\n(no output captured)');
  });

  it('names the signal when the child is terminated', async () => {
    // Killed from here rather than by the child itself: Windows reports the
    // signal it was asked to terminate with, but a self-termination surfaces
    // only as exit code 1.
    const server = new ScriptedTestServer(nodeScript(STAY_ALIVE));

    const attempt = server.start();
    (await waitForChild(server)).kill('SIGKILL');

    await expect(attempt).rejects.toThrow('(signal SIGKILL)');
    await expect(attempt).rejects.toThrow('exited prematurely with code null');
  });

  it('keeps only the tail of a noisy child', async () => {
    const server = new ScriptedTestServer(
      nodeScript(
        "process.stdout.write('HEAD-MARKER' + 'x'.repeat(9000) + " +
          "'TAIL-MARKER\\n', () => process.exit(1));",
      ),
    );

    const error = await server.start().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      expect.fail('expected start() to reject with an Error');
    }
    expect(error.message).toContain('TAIL-MARKER');
    expect(error.message).not.toContain('HEAD-MARKER');
  });

  it('reports a spawn failure with the captured output', async () => {
    const server = new ScriptedTestServer(() => {
      const child = spawn('adk-binary-that-does-not-exist', []);
      spawned.push(child);
      return child;
    });

    const attempt = server.start();

    await expect(attempt).rejects.toThrow('Failed to start scripted');
    await expect(attempt).rejects.toThrow('(no output captured)');
  });

  it('surfaces the captured output on a start-up timeout', async () => {
    const server = new ScriptedTestServer(
      nodeScript(
        `process.stdout.write('NOISE-BEFORE-TIMEOUT\\n');${STAY_ALIVE}`,
      ),
    );

    const attempt = server.start(300);

    await expect(attempt).rejects.toThrow('Timeout waiting for scripted');
    await expect(attempt).rejects.toThrow('NOISE-BEFORE-TIMEOUT');

    await server.stop();
    expect(server.child).toBeDefined();
    expect(hasExited(server.child!)).toBe(true);
  });

  it('keeps draining the pipes after the handshake settles', async () => {
    // Far beyond the 64 KB pipe buffer on both streams: if the handshake left
    // either unread, the child would block on write and never reach exit(0).
    const server = new ScriptedTestServer(
      nodeScript(
        `process.stdout.write('${START_MESSAGE}\\n');` +
          "setTimeout(() => process.stderr.write('e'.repeat(500000), " +
          "() => process.stdout.write('y'.repeat(500000), " +
          '() => process.exit(0))), 10);',
      ),
    );

    await server.start();
    const child = server.child;
    expect(child).toBeDefined();

    await new Promise<void>((resolve) => child!.once('close', () => resolve()));
    expect(child!.exitCode).toBe(0);
  });
});

describe('BaseTestServer.stop', () => {
  it('returns only once the child has actually exited', async () => {
    // The child delays its exit past the 500 ms the harness used to sleep for,
    // so a fixed sleep would return while it was still running.
    const server = new ScriptedTestServer(
      nodeScript(
        "process.on('SIGINT', () => setTimeout(() => process.exit(0), 800));" +
          `process.stdout.write('${START_MESSAGE}\\n');${STAY_ALIVE}`,
      ),
    );
    await server.start();
    const child = server.child;
    expect(child).toBeDefined();

    await server.stop();

    expect(hasExited(child!)).toBe(true);
  });

  it('escalates to SIGKILL when the child ignores SIGINT', async () => {
    const server = new ScriptedTestServer(
      nodeScript(
        "process.on('SIGINT', () => {});" +
          `process.stdout.write('${START_MESSAGE}\\n');${STAY_ALIVE}`,
      ),
    );
    await server.start();
    const child = server.child;
    expect(child).toBeDefined();

    await server.stop();

    // Windows emulates SIGINT as unconditional termination, so the child cannot
    // ignore it and the escalation never arms; POSIX reaches the SIGKILL path.
    expect(child!.signalCode).toBe(IS_WINDOWS ? 'SIGINT' : 'SIGKILL');
  }, 20000);

  it('returns when a grandchild still holds the inherited stdio pipes', async () => {
    // `go run` behaves this way: killing the wrapper leaves the built binary
    // holding the pipes, so the wrapper emits 'exit' but never 'close'. The
    // grandchild here outlives the assertion window on purpose -- teardown
    // reaps it -- so waiting on 'close' cannot pass by simply outlasting it.
    const pidFile = path.join(
      mkdtempSync(path.join(tmpdir(), 'adk-harness-')),
      'grandchild.pid',
    );
    grandchildPidFiles.push(pidFile);
    const server = new ScriptedTestServer(
      nodeScript(
        "const gc = require('node:child_process').spawn(process.execPath, " +
          "['-e', 'setTimeout(() => {}, 60000)'], {stdio: 'inherit'});" +
          // Recorded by the parent, which knows the pid the moment it spawns,
          // so teardown cannot race the grandchild's own start-up.
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, ` +
          'String(gc.pid));' +
          `process.stdout.write('${START_MESSAGE}\\n');${STAY_ALIVE}`,
      ),
    );
    await server.start();
    const child = server.child;
    expect(child).toBeDefined();

    const startedAt = Date.now();
    await server.stop();

    expect(hasExited(child!)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(PROCESS_EXIT_TIMEOUT_MS);
  });

  it('is a no-op on a server that was never started', async () => {
    const server = new ScriptedTestServer(nodeScript(STAY_ALIVE));

    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('is safe to call twice, and on a child that already exited', async () => {
    const server = new ScriptedTestServer(
      nodeScript(
        `process.stdout.write('${START_MESSAGE}\\n');` +
          'setTimeout(() => process.exit(0), 10);',
      ),
    );
    await server.start();
    const child = server.child;
    expect(child).toBeDefined();
    await new Promise<void>((resolve) => child!.once('close', () => resolve()));

    await expect(server.stop()).resolves.toBeUndefined();
    await expect(server.stop()).resolves.toBeUndefined();
  });
});
