/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {spawn} from 'node:child_process';
import * as net from 'node:net';
import {afterEach, describe, expect, it} from 'vitest';
import {
  getFreePort,
  MAX_CAPTURED_OUTPUT_BYTES,
  waitForProcessStart,
} from './process_utils.js';
import {tick} from './test_case_utils.js';

const START_MESSAGE = 'SCRIPTED SERVER STARTED';
const SERVER_NAME = 'Scripted';
/** Comfortably longer than a `node -e` child needs to print and exit. */
const START_TIMEOUT_MS = 15000;
/** Keeps a scripted child alive until the test kills it. */
const STAY_ALIVE = 'setTimeout(() => {}, 30000);';

const children: ChildProcessWithoutNullStreams[] = [];
const sockets: net.Server[] = [];

/** Spawns a `node -e` child running `script`, killed during teardown. */
function spawnScript(script: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ['-e', script]);
  children.push(child);
  return child;
}

/** Runs the start handshake against a child scripted by `script`. */
function startScript(
  script: string,
  timeoutMs = START_TIMEOUT_MS,
): Promise<void> {
  return waitForProcessStart({
    childProcess: spawnScript(script),
    startMessage: START_MESSAGE,
    serverName: SERVER_NAME,
    timeoutMs,
  });
}

/** Binds `port` for the duration of the test, to prove it was bindable. */
function listenOn(port: number): Promise<void> {
  const socket = net.createServer();
  sockets.push(socket);

  return new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen({host: 'localhost', port}, () => resolve());
  });
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

describe('waitForProcessStart', () => {
  it('surfaces the stdout a child wrote before exiting', async () => {
    const attempt = startScript(
      "process.stdout.write('BOOM-STDOUT\\n', () => process.exit(1));",
    );

    await expect(attempt).rejects.toThrow(
      'Scripted exited prematurely with code 1',
    );
    await expect(attempt).rejects.toThrow('BOOM-STDOUT');
  });

  it('surfaces the stderr a child wrote before exiting', async () => {
    const attempt = startScript(
      "process.stderr.write('BOOM-STDERR\\n', () => process.exit(1));",
    );

    await expect(attempt).rejects.toThrow('BOOM-STDERR');
  });

  it('surfaces both streams when the child writes to each', async () => {
    const attempt = startScript(
      "process.stdout.write('BOOM-STDOUT\\n', () => " +
        "process.stderr.write('BOOM-STDERR\\n', () => process.exit(1)));",
    );

    await expect(attempt).rejects.toThrow('BOOM-STDOUT');
    await expect(attempt).rejects.toThrow('BOOM-STDERR');
  });

  it('names the terminating signal when the child is killed', async () => {
    const child = spawnScript(STAY_ALIVE);
    const attempt = waitForProcessStart({
      childProcess: child,
      startMessage: START_MESSAGE,
      serverName: SERVER_NAME,
      timeoutMs: START_TIMEOUT_MS,
    });

    child.kill('SIGKILL');

    await expect(attempt).rejects.toThrow('(signal: SIGKILL)');
    // A signalled child reports a null code, so the code alone is no diagnosis.
    await expect(attempt).rejects.toThrow(
      'Scripted exited prematurely with code null',
    );
  });

  it('resolves when the child signals readiness', async () => {
    await expect(
      startScript(`process.stdout.write('${START_MESSAGE}\\n');${STAY_ALIVE}`),
    ).resolves.toBeUndefined();
  });

  it('matches a start message split across two writes', async () => {
    const head = START_MESSAGE.slice(0, 8);
    const tail = START_MESSAGE.slice(8);

    await expect(
      startScript(
        `process.stdout.write('${head}');` +
          `setTimeout(() => process.stdout.write('${tail}\\n'), 50);` +
          STAY_ALIVE,
      ),
    ).resolves.toBeUndefined();
  });

  it('does not reject when a started child exits later', async () => {
    const child = spawnScript(
      `process.stdout.write('${START_MESSAGE}\\n');` +
        'setTimeout(() => process.exit(0), 20);',
    );
    let rejection: unknown;
    const attempt = waitForProcessStart({
      childProcess: child,
      startMessage: START_MESSAGE,
      serverName: SERVER_NAME,
      timeoutMs: START_TIMEOUT_MS,
    });
    attempt.catch((error: unknown) => {
      rejection = error;
    });

    await expect(attempt).resolves.toBeUndefined();
    await tick(50);

    expect(rejection).toBeUndefined();
    expect(child.exitCode).toBe(0);
    // The handshake released its listeners rather than leaking them onto a
    // server that outlives it.
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });

  it('carries the captured output on a readiness timeout', async () => {
    const attempt = startScript(
      `process.stdout.write('noise-before-timeout\\n');${STAY_ALIVE}`,
      500,
    );

    await expect(attempt).rejects.toThrow('Timeout waiting for scripted');
    await expect(attempt).rejects.toThrow('noise-before-timeout');
  });

  it('reports a spawn failure with the empty capture', async () => {
    const child = spawn('adk-binary-that-does-not-exist', []);
    children.push(child);

    const attempt = waitForProcessStart({
      childProcess: child,
      startMessage: START_MESSAGE,
      serverName: SERVER_NAME,
      timeoutMs: START_TIMEOUT_MS,
    });

    await expect(attempt).rejects.toThrow('Failed to start scripted');
    await expect(attempt).rejects.toThrow('(no output captured)');
  });

  it('bounds the capture to the tail of a noisy child', async () => {
    const filler = 'F'.repeat(1000);
    const attempt = startScript(
      `for (let i = 0; i < 200; i++) process.stdout.write('${filler}\\n');` +
        "process.stdout.write('LAST-WORDS\\n', () => process.exit(1));",
    );

    const error = await attempt.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      expect.fail('expected the handshake to reject with an Error');
    }
    // The child wrote >200 KB; only the tail of each stream is retained.
    expect(error.message).toContain('LAST-WORDS');
    expect(error.message.length).toBeLessThan(3 * MAX_CAPTURED_OUTPUT_BYTES);
  });
});

describe('getFreePort', () => {
  it('returns a port that can actually be bound', async () => {
    const port = await getFreePort();

    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    await expect(listenOn(port)).resolves.toBeUndefined();
  });

  it('returns a bindable port on each sequential call', async () => {
    const first = await getFreePort();
    await expect(listenOn(first)).resolves.toBeUndefined();

    const second = await getFreePort();
    await expect(listenOn(second)).resolves.toBeUndefined();

    expect(second).not.toBe(first);
  });
});
