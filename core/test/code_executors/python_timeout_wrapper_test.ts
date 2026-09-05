/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {SpawnSyncReturns, spawnSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  PYTHON_TIMEOUT_WRAPPER,
  TIMEOUT_EXIT_CODE,
} from '../../src/code_executors/python_timeout_wrapper.js';

/**
 * The supervisor is a string of Python that only ever runs inside a container,
 * so these tests run it on the host exactly as the executor asks the container
 * to run it. No Docker daemon is involved.
 */
const PYTHON = 'python3';

/** Budget for one supervised run, and for the test that waits on it. */
const RUN_TIMEOUT_MS = 20000;
const TEST_TIMEOUT_MS = 30000;

/** POSIX signal number for SIGTERM, which a killed run reports as 128 + 15. */
const SIGTERM_NUMBER = 15;

/** POSIX sessions and `killpg` are what the supervisor is built on. */
const isPosix = os.platform() !== 'win32';
const hasPython =
  isPosix && spawnSync(PYTHON, ['--version'], {timeout: 10000}).status === 0;

/** Runs the supervisor over `argv` with a bound of `timeout` seconds. */
function runWrapper(timeout: number, argv: string[]): SpawnSyncReturns<string> {
  return spawnSync(
    PYTHON,
    ['-c', PYTHON_TIMEOUT_WRAPPER, String(timeout), ...argv],
    {encoding: 'utf8', timeout: RUN_TIMEOUT_MS},
  );
}

/** Runs a Python snippet under the supervisor. */
function runPython(timeout: number, code: string): SpawnSyncReturns<string> {
  return runWrapper(timeout, [PYTHON, '-c', code]);
}

/** Returns whether `pid` is a live, non-zombie process. */
function isAlive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return (
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[0] !== 'Z'
    );
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!hasPython)('PYTHON_TIMEOUT_WRAPPER', () => {
  it(
    'kills a run that hits the bound',
    () => {
      const started = Date.now();

      const completed = runPython(1, 'while True: pass');

      expect(completed.status).toBe(TIMEOUT_EXIT_CODE);
      expect(Date.now() - started).toBeLessThan(15000);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cannot be disarmed by the executed code',
    () => {
      const completed = runPython(
        1,
        'import signal, time\n' +
          'signal.alarm(0)\n' +
          'signal.signal(signal.SIGALRM, signal.SIG_IGN)\n' +
          'time.sleep(25)\n' +
          'print("outlived the bound")\n',
      );

      expect(completed.status).toBe(TIMEOUT_EXIT_CODE);
      expect(completed.stdout).not.toContain('outlived the bound');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'bounds a command that is not python',
    () => {
      const completed = runWrapper(1, ['sh', '-c', 'while true; do :; done']);

      expect(completed.status).toBe(TIMEOUT_EXIT_CODE);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves argv as a plain python3 -c run would',
    () => {
      const completed = runPython(
        5,
        'import argparse, sys\n' +
          'argparse.ArgumentParser().parse_args()\n' +
          'print(sys.argv)\n',
      );

      expect(completed.status).toBe(0);
      expect(completed.stdout.trim()).toBe("['-c']");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'passes through the output and the exit status',
    () => {
      const completed = runPython(5, 'import sys\nprint("hello")\nsys.exit(3)');

      expect(completed.status).toBe(3);
      expect(completed.stdout.trim()).toBe('hello');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a command a signal killed as 128 plus that signal',
    () => {
      const completed = runPython(
        5,
        'import os, signal\nos.kill(os.getpid(), signal.SIGTERM)\n',
      );

      expect(completed.status).toBe(128 + SIGTERM_NUMBER);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports an uncaught error against the original line',
    () => {
      const completed = runPython(5, 'x = 1\nraise ValueError("boom")\n');

      expect(completed.status).toBe(1);
      expect(completed.stderr).toContain('line 2');
      expect(completed.stderr).toContain('boom');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a command it cannot run',
    () => {
      const completed = runWrapper(5, ['adk-no-such-command']);

      expect(completed.status).toBe(1);
      expect(completed.stderr).toContain('FileNotFoundError');
    },
    TEST_TIMEOUT_MS,
  );

  describe.skipIf(!fs.existsSync('/proc'))('process group', () => {
    let tempDir = '';

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-wrapper-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, {recursive: true, force: true});
    });

    it(
      'kills what the code spawned',
      async () => {
        const pidFile = path.join(tempDir, 'spawned.pid');

        const completed = runPython(
          1,
          'import os, time\n' +
            'spawned = os.fork()\n' +
            'if spawned == 0:\n' +
            '  time.sleep(60)\n' +
            '  os._exit(0)\n' +
            `with open(${JSON.stringify(pidFile)}, 'w') as f:\n` +
            '  f.write(str(spawned))\n' +
            'time.sleep(60)\n',
        );

        expect(completed.status).toBe(TIMEOUT_EXIT_CODE);
        expect(fs.existsSync(pidFile)).toBe(true);
        const spawnedPid = Number(fs.readFileSync(pidFile, 'utf8'));
        try {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline && isAlive(spawnedPid)) {
            await sleep(50);
          }
          expect(isAlive(spawnedPid)).toBe(false);
        } finally {
          try {
            process.kill(spawnedPid, 'SIGKILL');
          } catch {
            // Already gone, which is the expected outcome.
          }
        }
      },
      TEST_TIMEOUT_MS,
    );
  });
});
