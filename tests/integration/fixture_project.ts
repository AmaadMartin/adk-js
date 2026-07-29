/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {exec} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {promisify} from 'node:util';

const execAsync = promisify(exec);

/**
 * Upper bound for a hook that installs or removes a fixture's dependencies.
 * Every fixture depends on `file:` paths into `core` and `dev`, so a cold
 * runner has to resolve their full transitive graph. This is a hang guard, not
 * an expected runtime.
 */
export const FIXTURE_HOOK_TIMEOUT_MS = 180_000;

/** Upper bound for a test that spawns a fixture agent process. */
export const FIXTURE_RUN_TIMEOUT_MS = 120_000;

/** A verbose install easily exceeds the 1 MB default `exec` buffer. */
const EXEC_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Cache-first, quiet install. Fixtures resolve against the local working tree,
 * so the audit and funding round-trips only add latency.
 */
const NPM_INSTALL_COMMAND = 'npm install --prefer-offline --no-audit --no-fund';

/** Everything a fixture install or build can leave behind; all gitignored. */
const FIXTURE_ARTIFACTS = ['node_modules', 'package-lock.json', 'dist'];

/**
 * Installs a fixture project's dependencies.
 *
 * @param projectPath Absolute path to a directory containing a `package.json`.
 * @throws An `Error` naming the fixture, caused by the `exec` failure that
 *     carries npm's exit code and output. A silent install failure surfaces
 *     later as an unrelated-looking spawn error, so it is always reported here.
 */
export async function installFixtureProject(
  projectPath: string,
): Promise<void> {
  try {
    await execAsync(NPM_INSTALL_COMMAND, {
      cwd: projectPath,
      maxBuffer: EXEC_MAX_BUFFER_BYTES,
    });
  } catch (error: unknown) {
    throw new Error(`npm install failed in ${projectPath}`, {cause: error});
  }
}

/**
 * Removes everything a fixture install and build produced.
 *
 * Best effort: a cleanup failure (a lingering file handle on Windows, say) must
 * never turn a passing suite red, so removal errors are swallowed.
 */
export async function cleanupFixtureProject(
  projectPath: string,
): Promise<void> {
  await Promise.all(
    FIXTURE_ARTIFACTS.map((target) =>
      fs
        .rm(path.join(projectPath, target), {recursive: true, force: true})
        .catch(() => {}),
    ),
  );
}
