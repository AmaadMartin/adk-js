/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execFile, type ExecFileException} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Budget (ms) for the one-off `go mod tidy` that populates a module's `go.sum`.
 *
 * A cold tidy of the two cross-language Go modules measured 3.2s against an
 * empty module cache. 45000 is about 14x that, which leaves room for two Vitest
 * workers that contend on the shared module cache. It stays below the 60000
 * per-hook and per-test budget of the cross-language suites, so a wedged
 * download reports the message from {@link ensureGoModules} rather than a
 * generic Vitest timeout.
 */
export const GO_MOD_TIDY_TIMEOUT_MS = 45000;

/** The fields of an `execFile` rejection that classify a failure. */
type ExecFileFailure = Pick<ExecFileException, 'code' | 'killed' | 'stderr'>;

function isExecFileFailure(error: unknown): error is ExecFileFailure {
  return typeof error === 'object' && error !== null;
}

function describeFailure(error: unknown, timeoutMs: number): string {
  if (!isExecFileFailure(error)) {
    return String(error);
  }
  if (error.code === 'ENOENT') {
    return "the 'go' executable was not found on PATH";
  }
  if (error.killed) {
    return `it exceeded its ${timeoutMs}ms budget`;
  }
  const stderr = error.stderr?.trim();
  return stderr
    ? `it exited with code ${error.code}\n${stderr}`
    : `it exited with code ${error.code}`;
}

/**
 * Populates `moduleDir`'s `go.sum` if it is absent. `go.sum` is gitignored, so
 * a fresh clone never has one.
 *
 * This is a no-op when `go.sum` already exists, which is always the case on CI:
 * the cross-language workflow tidies both modules in a dedicated step.
 *
 * @param moduleDir Absolute path of a directory that contains a `go.mod`.
 * @param timeoutMs Budget for the tidy. Defaults to
 *     {@link GO_MOD_TIDY_TIMEOUT_MS}.
 * @throws Error naming the module directory and the concrete cause: a missing
 *     `go` executable, a non-zero exit, or the timeout. Nothing is swallowed,
 *     so the caller never spawns `go run .` against an unresolved module.
 */
export async function ensureGoModules(
  moduleDir: string,
  timeoutMs: number = GO_MOD_TIDY_TIMEOUT_MS,
): Promise<void> {
  if (fs.existsSync(path.join(moduleDir, 'go.sum'))) {
    return;
  }

  try {
    await execFileAsync('go', ['mod', 'tidy'], {
      cwd: moduleDir,
      timeout: timeoutMs,
    });
  } catch (error: unknown) {
    throw new Error(
      `go mod tidy failed in ${moduleDir}: ` +
        `${describeFailure(error, timeoutMs)}. ` +
        `Install the Go toolchain (https://go.dev/dl/) or run 'go mod tidy' ` +
        `in that directory manually before running the cross-language tests.`,
      {cause: error},
    );
  }
}
