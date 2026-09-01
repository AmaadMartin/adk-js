/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import Dockerode from 'dockerode';
import {PassThrough} from 'node:stream';
import {Mock, MockInstance, vi} from 'vitest';

/** The termination signals `docker_container.ts` cleans up on. */
export type ExitSignal = 'SIGINT' | 'SIGTERM';

/** How the fake Docker client behaves for one test. */
export interface FakeDockerConfig {
  /** Bytes the exec writes to standard output. */
  stdout?: string;
  /** Bytes the exec writes to standard error. */
  stderr?: string;
  /** Status of the first exec, the `which python3` probe. Defaults to 0. */
  probeExitCode?: number | null;
  /** Status of every exec after the probe. Defaults to 0. */
  exitCode?: number | null;
  /** Error the image build reports through `followProgress`. */
  buildError?: Error;
  /** Error the exec output stream emits instead of ending. */
  execStreamError?: Error;
  /**
   * Errors `stop()` rejects with, one per call, before it starts resolving.
   * Lets a test make the first cleanup fail and the retry succeed.
   */
  stopErrors?: Error[];
}

/** The fake container `createContainer` resolves to. */
export interface FakeContainer {
  id: string;
  /** Typed so that a test can read the `Cmd` of a call without a cast. */
  exec: Mock<(options: Dockerode.ExecCreateOptions) => unknown>;
  start: Mock;
  stop: Mock;
  remove: Mock;
}

/** The parts of the Docker client the code executors drive. */
export interface FakeDocker {
  createContainer: Mock;
  buildImage: Mock;
  modem: {demuxStream: Mock; followProgress: Mock};
}

/**
 * Builds a fake Docker client that mimics the streaming exec protocol without
 * touching a real daemon.
 *
 * The `dockerode` module is mocked to a bare constructor in every test file
 * that calls this, so `new Dockerode()` yields an empty instance the compiler
 * already types as `Dockerode`. Extending that instance gives a fake the
 * executor accepts without a cast.
 */
export function createFakeDocker(config: FakeDockerConfig = {}): {
  docker: Dockerode & FakeDocker;
  container: FakeContainer;
} {
  const {
    stdout = '',
    stderr = '',
    probeExitCode = 0,
    exitCode = 0,
    buildError,
    execStreamError,
    stopErrors = [],
  } = config;

  let execCount = 0;
  let stopCount = 0;

  const container: FakeContainer = {
    id: 'test-container-id',
    exec: vi.fn(async (_options: Dockerode.ExecCreateOptions) => {
      const status = execCount++ === 0 ? probeExitCode : exitCode;
      return {
        start: vi.fn().mockResolvedValue(new PassThrough()),
        inspect: vi.fn().mockResolvedValue({ExitCode: status}),
      };
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(async () => {
      const error = stopErrors[stopCount++];
      if (error) {
        throw error;
      }
    }),
    remove: vi.fn().mockResolvedValue(undefined),
  };

  const fake: FakeDocker = {
    createContainer: vi.fn().mockResolvedValue(container),
    buildImage: vi.fn().mockResolvedValue(new PassThrough()),
    modem: {
      demuxStream: vi.fn(
        (source: PassThrough, out: PassThrough, err: PassThrough) => {
          if (stdout) {
            out.write(Buffer.from(stdout));
          }
          if (stderr) {
            err.write(Buffer.from(stderr));
          }
          setImmediate(() =>
            execStreamError
              ? source.emit('error', execStreamError)
              : source.emit('end'),
          );
        },
      ),
      followProgress: vi.fn(
        (_stream: unknown, done: (error: Error | null) => void) =>
          done(buildError ?? null),
      ),
    },
  };

  return {docker: Object.assign(new Dockerode(), fake), container};
}

/**
 * Returns the signal handler `docker_container.ts` registered on process exit:
 * the one function listening on both SIGINT and SIGTERM.
 */
export function getExitSignalHandler(): (signal: ExitSignal) => Promise<void> {
  const onSigterm: unknown[] = process.listeners('SIGTERM');
  const handler = process
    .listeners('SIGINT')
    .find((listener) => onSigterm.includes(listener));
  if (!handler) {
    throw new Error('the exit signal handler was never registered');
  }
  return handler as (signal: ExitSignal) => Promise<void>;
}

/**
 * Runs the exit signal handler with `process.kill` stubbed, so the re-raise
 * does not terminate the test worker. Returns the stub for assertions.
 */
export async function runExitSignalHandler(
  signal: ExitSignal = 'SIGTERM',
): Promise<MockInstance<typeof process.kill>> {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  await getExitSignalHandler()(signal);
  return kill;
}
