/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ChildProcessWithoutNullStreams} from 'node:child_process';
import * as net from 'node:net';

/** Cap on captured child output per stream, in bytes. */
export const MAX_CAPTURED_OUTPUT_BYTES = 16384;

/**
 * Appends `chunk` to `captured`, keeping only its trailing
 * {@link MAX_CAPTURED_OUTPUT_BYTES} bytes. A child that dies noisily can write
 * far more than is useful, and the bytes it wrote last are the ones that
 * explain why.
 */
function appendBounded(captured: Buffer, chunk: Buffer): Buffer {
  return Buffer.concat([captured, chunk]).subarray(-MAX_CAPTURED_OUTPUT_BYTES);
}

/**
 * Renders both captured streams, labelled with the server they came from so
 * they stay readable in a CI log that interleaves several vitest projects.
 */
function formatCapture(
  serverName: string,
  stdout: Buffer,
  stderr: Buffer,
): string {
  const section = (label: string, output: Buffer) =>
    `\n--- ${serverName} ${label} ---\n` +
    (output.length > 0 ? output.toString() : '(no output captured)');

  return section('stdout', stdout) + section('stderr', stderr);
}

/**
 * Resolves once `startMessage` appears on the child's stdout.
 *
 * Rejects if the child closes first, fails to spawn, or does not signal
 * readiness within `timeoutMs` — in every case with the child's captured
 * stdout and stderr in the message, since the reason a server refused to start
 * only ever exists in its own output. Both streams are captured because the
 * ADK CLI logs its start-up failures to stdout, not stderr.
 */
export function waitForProcessStart({
  childProcess,
  startMessage,
  serverName,
  timeoutMs,
}: {
  childProcess: ChildProcessWithoutNullStreams;
  startMessage: string;
  serverName: string;
  timeoutMs: number;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);

    // Detaching the handlers leaves both streams in flowing mode, so a healthy
    // long-lived server keeps draining instead of blocking on a full pipe, and
    // drops the last reference to the captured buffers.
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      childProcess.stdout.off('data', onStdout);
      childProcess.stderr.off('data', onStderr);
      childProcess.off('error', onError);
      childProcess.off('close', onClose);
      finish();
    };

    const onStdout = (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
      if (stdout.includes(startMessage)) {
        settle(resolve);
      }
    };

    const onStderr = (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    };

    const onError = (error: Error) => {
      settle(() =>
        reject(
          new Error(
            `Failed to start ${serverName.toLowerCase()}: ${error.message}` +
              formatCapture(serverName, stdout, stderr),
          ),
        ),
      );
    };

    // 'close' rather than 'exit': it fires only once the child's stdio has
    // been drained, so its last words are already captured. The two events
    // have no guaranteed order relative to each other.
    const onClose = (
      code: number | null,
      signal: ChildProcessWithoutNullStreams['signalCode'],
    ) => {
      settle(() =>
        reject(
          new Error(
            `${serverName} exited prematurely with code ${code} ` +
              `(signal: ${signal ?? 'none'}).` +
              formatCapture(serverName, stdout, stderr),
          ),
        ),
      );
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `Timeout waiting for ${serverName.toLowerCase()} to start.` +
              formatCapture(serverName, stdout, stderr),
          ),
        ),
      );
    }, timeoutMs);

    childProcess.stdout.on('data', onStdout);
    childProcess.stderr.on('data', onStderr);
    childProcess.on('error', onError);
    childProcess.on('close', onClose);
  });
}

/**
 * Returns a port the OS has just confirmed is bindable on `host`, by listening
 * on port 0 and releasing it again.
 *
 * This narrows the bind race rather than eliminating it: another process can
 * still claim the port between the release here and the child's bind. Its real
 * value is that the OS will not hand the same ephemeral port to two
 * concurrently-starting vitest workers, which a shared random range can.
 */
export async function getFreePort(host = 'localhost'): Promise<number> {
  const server = net.createServer();

  try {
    return await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen({host, port: 0}, () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(
            new Error(`Expected a TCP address on ${host}, got ${address}`),
          );
          return;
        }
        resolve(address.port);
      });
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
