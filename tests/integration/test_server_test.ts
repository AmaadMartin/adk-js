/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {spawn} from 'node:child_process';
import * as net from 'node:net';
import {afterEach, describe, expect, it} from 'vitest';
import {BaseTestServer, reserveFreePort} from './test_case_utils.js';

const HOST = '127.0.0.1';
/** Split in two so a test can straddle the start message across writes. */
const START_MESSAGE_HEAD = 'SCRIPTED SERVER ';
const START_MESSAGE_TAIL = 'STARTED';
const START_MESSAGE = `${START_MESSAGE_HEAD}${START_MESSAGE_TAIL}`;
// Stays under vitest's default 5s test timeout so a startup failure is
// reported by this harness rather than by the runner.
const START_TIMEOUT_MS = 4_000;
const SHORT_TIMEOUT_MS = 500;
const MISSING_COMMAND = 'adk-command-that-does-not-exist';

/** Keeps a fake child running until the test kills it. */
const STAY_ALIVE = 'setTimeout(() => {}, 30000);';

const START_ONLY = `process.stdout.write('${START_MESSAGE}\\n');${STAY_ALIVE}`;
const SPLIT_START_MESSAGE = `process.stdout.write('${START_MESSAGE_HEAD}');setTimeout(() => process.stdout.write('${START_MESSAGE_TAIL}\\n'), 50);${STAY_ALIVE}`;
const FAIL_AFTER_LOGGING =
  "process.stdout.write('loading configuration\\n', () => process.stderr.write('Port 12345 is already in use\\n', () => process.exit(1)));";

const children: ChildProcessWithoutNullStreams[] = [];
const sockets: net.Server[] = [];

/**
 * A `BaseTestServer` backed by a scripted `node -e` child, so that startup
 * behaviour (banner shape, premature exit, silence) is fully determined by the
 * test rather than by a real server.
 */
class ScriptedServer extends BaseTestServer {
  /** The value of `this.port` observed at the moment the child was spawned. */
  portAtSpawn?: number;
  private readonly command: string;

  constructor(
    private readonly script: string,
    {port, command = process.execPath}: {port?: number; command?: string} = {},
  ) {
    super(HOST, port);
    this.command = command;
  }

  get child(): ChildProcessWithoutNullStreams | undefined {
    return this.serverProcess;
  }

  async start(timeoutMs = START_TIMEOUT_MS): Promise<void> {
    await this.startProcess({
      spawnProcess: () => {
        this.portAtSpawn = this.port;
        const child = spawn(this.command, ['-e', this.script]);
        children.push(child);

        return child;
      },
      startMessage: START_MESSAGE,
      successLogMessage: 'Scripted server started',
      serverName: 'Scripted Server',
      timeoutMs,
    });
  }
}

/** Holds `port` open for the duration of the test. */
function listenOn(port: number): Promise<void> {
  const socket = net.createServer();
  sockets.push(socket);

  return new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen({host: HOST, port}, () => resolve());
  });
}

function countActiveTimers(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === 'Timeout').length;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL');
  }
  await Promise.all(
    sockets
      .splice(0)
      .map(
        (socket) =>
          new Promise<void>((resolve) => socket.close(() => resolve())),
      ),
  );
});

describe('reserveFreePort', () => {
  it('returns a bindable port that is not one already held', async () => {
    const port = await reserveFreePort(HOST);

    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    await expect(listenOn(port)).resolves.toBeUndefined();

    expect(await reserveFreePort(HOST)).not.toBe(port);
  });
});

describe('BaseTestServer.startProcess', () => {
  it('matches a start message split across two writes', async () => {
    const server = new ScriptedServer(SPLIT_START_MESSAGE);

    await expect(server.start()).resolves.toBeUndefined();
  });

  it('reports both captured streams when the child exits before starting', async () => {
    const attempt = new ScriptedServer(FAIL_AFTER_LOGGING).start();

    await expect(attempt).rejects.toThrow('exited prematurely with code 1');
    await expect(attempt).rejects.toThrow('loading configuration');
    await expect(attempt).rejects.toThrow('Port 12345 is already in use');
  });

  it('reports a spawn failure', async () => {
    const attempt = new ScriptedServer(START_ONLY, {
      command: MISSING_COMMAND,
    }).start();

    await expect(attempt).rejects.toThrow('Failed to start scripted server');
  });

  it('reports the captured output on a start timeout', async () => {
    const attempt = new ScriptedServer(STAY_ALIVE).start(SHORT_TIMEOUT_MS);

    await expect(attempt).rejects.toThrow(
      'Timeout waiting for scripted server to start.',
    );
    await expect(attempt).rejects.toThrow('--- stdout ---\n(empty)');
    await expect(attempt).rejects.toThrow('--- stderr ---\n(empty)');
  });

  it('reserves a free port before spawning when none was requested', async () => {
    const server = new ScriptedServer(START_ONLY);

    await server.start();

    expect(server.portAtSpawn).toBeGreaterThan(0);
    expect(server.port).toBe(server.portAtSpawn);
  });

  it('honours an explicitly requested port', async () => {
    const requested = await reserveFreePort(HOST);
    const server = new ScriptedServer(START_ONLY, {port: requested});

    await server.start();

    expect(server.portAtSpawn).toBe(requested);
    expect(server.url).toBe(`http://${HOST}:${requested}`);
  });

  it('leaves no pending timer or stream listener behind', async () => {
    const server = new ScriptedServer(START_ONLY);

    await server.start(START_TIMEOUT_MS);

    expect(countActiveTimers()).toBe(0);
    const child = server.child;
    if (!child) {
      expect.fail('expected the scripted server to have spawned a child');
    }
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });
});
