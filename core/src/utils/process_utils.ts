/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ChildProcessWithoutNullStreams} from 'node:child_process';
import * as os from 'node:os';
import {logger} from './logger.js';

/**
 * Whether a spawned command can lead its own process group.
 *
 * Windows has no process group to signal, and `detached` there opens a console
 * window instead. Only the command itself can be reached on that platform.
 *
 * Pass it as the `detached` option of `spawn` so that {@link killCommand} can
 * reach everything the command started.
 */
export const USE_PROCESS_GROUP = os.platform() !== 'win32';

/**
 * How long to wait for a command to exit after `SIGTERM` before escalating to
 * `SIGKILL`, and then for its output pipes to close, so that tearing a command
 * down cannot itself block forever.
 */
const TERMINATE_GRACE_MS = 5_000;

/** The name of a signal that can terminate a command, e.g. `'SIGKILL'`. */
export type SignalName = keyof typeof os.constants.signals;

/**
 * Maps Node's `(code, signal)` pair to the negative-signal convention, under
 * which a command killed by `SIGKILL` reports `-9`.
 */
export function toExitCode(
  code: number | null,
  signal: SignalName | null,
): number {
  return signal === null ? (code ?? 0) : -os.constants.signals[signal];
}

/** Signals a command and everything it spawned, tolerating an empty group. */
function signalCommand(
  child: ChildProcessWithoutNullStreams,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  if (USE_PROCESS_GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch (e: unknown) {
      // An already-empty group reports ESRCH, which is not an error here.
      logger.debug(`Could not signal the command process group: ${e}`);
    }
  }
  child.kill(signal);
}

/** Waits up to `ms` for `promise` to settle, and reports whether it did. */
async function settledWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kills a command and its descendants, and waits for its output pipes.
 *
 * `SIGTERM` comes first, so the command and its children get a chance to exit
 * cleanly. The escalation to `SIGKILL` does not depend on the command itself
 * having exited: a descendant that ignores `SIGTERM` still holds the pipes
 * open, which is what keeps `closed` from settling.
 *
 * Both grace periods buy time for the process group to drain, so a platform
 * without one skips them: nothing there can reach a survivor holding the
 * pipes, whatever the wait.
 *
 * @param child The command to kill, spawned with `detached:
 *   {@link USE_PROCESS_GROUP}`.
 * @param closed Settles when the command emits `'close'`.
 */
export async function killCommand(
  child: ChildProcessWithoutNullStreams,
  closed: Promise<void>,
): Promise<void> {
  signalCommand(child, 'SIGTERM');

  if (USE_PROCESS_GROUP) {
    if (await settledWithin(closed, TERMINATE_GRACE_MS)) {
      return;
    }

    signalCommand(child, 'SIGKILL');
    if (await settledWithin(closed, TERMINATE_GRACE_MS)) {
      return;
    }

    // A descendant escaped the group by starting one of its own.
    logger.warn('Gave up reading output from a killed command.');
  }

  // Release the read ends rather than wait for whoever still holds them.
  // Whatever the command wrote before this point has already been buffered.
  child.stdout.destroy();
  child.stderr.destroy();

  // With the pipes released, 'close' reports the exit status the caller needs.
  // The wait is bounded, so teardown still cannot block forever.
  await settledWithin(closed, TERMINATE_GRACE_MS);
}
