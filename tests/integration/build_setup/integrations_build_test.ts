/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {exec} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';

const execAsync = promisify(exec);

const repoRoot = process.cwd();
const packageDir = path.join(repoRoot, 'integrations');
const distDir = path.join(packageDir, 'dist');

/**
 * Budget (ms) for one `rm -rf dist` plus one full workspace build. A build is
 * `tsc --emitDeclarationOnly` followed by three esbuild passes and takes ~2s on
 * a warm checkout; 60s absorbs a cold, loaded CI runner.
 */
const BUILD_TIMEOUT_MS = 60000;

interface PackageManifest {
  browser: string;
  main: string;
  module: string;
}

async function readManifest(): Promise<PackageManifest> {
  const raw = await fs.readFile(path.join(packageDir, 'package.json'), 'utf8');
  return JSON.parse(raw) as PackageManifest;
}

/**
 * Removes `integrations/dist` and reruns `script`, so that what the assertions
 * see was emitted by this build and not left behind by an earlier one.
 */
async function buildFromClean(script: string): Promise<void> {
  await fs.rm(distDir, {recursive: true, force: true});
  await execAsync(`npm run ${script} --workspace integrations`, {
    cwd: repoRoot,
  });
}

async function expectEmitted(entryPointField: string, relativePath: string) {
  const absolute = path.join(packageDir, relativePath);
  await expect(
    fs.access(absolute),
    `"${entryPointField}": "${relativePath}" was not emitted`,
  ).resolves.toBeUndefined();
  const {size} = await fs.stat(absolute);
  expect(size, `${relativePath} is empty`).toBeGreaterThan(0);
}

// Both cases rebuild the real `integrations/dist`. The bundled build runs
// first so the tree is left holding the plain build's output, which is what
// the rest of the repo expects. Nothing else reads `integrations/dist`.
describe('integrations build output', () => {
  it(
    'emits every entry point the manifest names, bundled',
    async () => {
      await buildFromClean('build:bundle');

      const manifest = await readManifest();
      await expectEmitted('browser', manifest.browser);
      await expectEmitted('main', manifest.main);
      await expectEmitted('module', manifest.module);

      const webDir = path.join(packageDir, path.dirname(manifest.browser));
      const emitted = await fs.readdir(webDir);
      expect(
        emitted.filter((name) => name.endsWith('.js')),
        'the bundled build must emit one bundle, not one file per source',
      ).toEqual([path.basename(manifest.browser)]);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'emits every entry point the manifest names, unbundled',
    async () => {
      await buildFromClean('build');

      const manifest = await readManifest();
      await expectEmitted('browser', manifest.browser);
      await expectEmitted('main', manifest.main);
      await expectEmitted('module', manifest.module);
    },
    BUILD_TIMEOUT_MS,
  );
});
