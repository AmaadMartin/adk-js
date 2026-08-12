/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execSync} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Resolved from this module's own location, so the fixture paths do not depend
 * on the directory the runner was started from.
 */
const INTEGRATION_ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Finds the fixture projects under `dir`, in a stable order.
 *
 * A directory holding a `package.json` is a fixture and ends the walk, so the
 * `file:` sub-packages a fixture depends on are never treated as projects of
 * their own: their parent installs them.
 */
async function findFixtureProjects(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, {withFileTypes: true});
  if (entries.some((entry) => entry.name === 'package.json')) {
    return [dir];
  }

  const subdirectories = entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .map((entry) => entry.name)
    .sort();

  const projects: string[] = [];
  for (const subdirectory of subdirectories) {
    projects.push(...(await findFixtureProjects(path.join(dir, subdirectory))));
  }
  return projects;
}

/**
 * Installs every fixture project, one at a time.
 *
 * The installs are sequential on purpose. Every fixture resolves the same
 * transitive tree, so concurrent `npm` processes only race for the registry
 * and for the shared `~/.npm` cache lock. `stdio: 'inherit'` reports npm's own
 * progress and diagnostics, the only output a run produces before the workers
 * start.
 */
export async function setup(): Promise<void> {
  for (const project of await findFixtureProjects(INTEGRATION_ROOT)) {
    execSync('npm install --no-audit --no-fund', {
      cwd: project,
      stdio: 'inherit',
    });
  }
}

/**
 * Removes what the installs produced.
 *
 * Removal errors are ignored, which is the contract the per-suite teardowns
 * had: a locked directory on Windows must not turn a passing run red.
 */
export async function teardown(): Promise<void> {
  for (const project of await findFixtureProjects(INTEGRATION_ROOT)) {
    await fs
      .rm(path.join(project, 'node_modules'), {recursive: true, force: true})
      .catch(() => {});
    await fs
      .rm(path.join(project, 'package-lock.json'), {force: true})
      .catch(() => {});
  }
}
