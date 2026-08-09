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

const FIXTURE_PROJECT_PATHS = [
  'agent_loader/__dirname',
  'agent_loader/__filename',
  'agent_loader/import_meta_url',
  'app_loader/app_default',
  'app_loader/app_js',
  'app_loader/app_ts',
  'app_loader/discovery',
  'build_setup/js_commonjs',
  'build_setup/js_esm',
  'build_setup/ts_commonjs',
  'build_setup/ts_commonjs_native_addon',
  'build_setup/ts_esm',
  'build_setup/ts_esm_native_addon',
  'skills/script_js',
];

/**
 * Absolute paths of every fixture project the integration suite runs.
 *
 * The list lives here so the suite can install each fixture exactly once,
 * before the worker pool starts. Installing from `beforeAll` hooks instead let
 * several `npm` processes race for the registry and the shared `~/.npm` cache
 * lock, and the slowest of them overran its hook budget.
 */
export const FIXTURE_PROJECT_DIRS: readonly string[] =
  FIXTURE_PROJECT_PATHS.map((project) => path.join(INTEGRATION_ROOT, project));

/**
 * Installs one fixture project's dependencies.
 *
 * `stdio: 'inherit'` puts npm's own progress and diagnostics on the terminal,
 * which is the only report a caller gets before the workers start.
 *
 * @throws Whatever `execSync` throws when npm exits non-zero.
 */
export function installFixture(projectDir: string): void {
  execSync('npm install --no-audit --no-fund', {
    cwd: projectDir,
    stdio: 'inherit',
  });
}

/**
 * Removes the `node_modules` and `package-lock.json` an install produced.
 *
 * Removal errors are ignored, which is the contract the per-suite teardowns
 * had: a locked directory on Windows must not turn a passing run red.
 */
export async function cleanFixture(projectDir: string): Promise<void> {
  await fs
    .rm(path.join(projectDir, 'node_modules'), {recursive: true, force: true})
    .catch(() => {});
  await fs
    .rm(path.join(projectDir, 'package-lock.json'), {force: true})
    .catch(() => {});
}
