/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  cleanupFixtureProject,
  installFixtureProject,
} from './fixture_project.js';

const scratchDirs: string[] = [];

async function createScratchDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-fixture-'));
  scratchDirs.push(dir);

  return dir;
}

async function exists(target: string): Promise<boolean> {
  return fs
    .access(target)
    .then(() => true)
    .catch(() => false);
}

/** Recreates what a fixture directory looks like after an install and build. */
async function seedInstalledFixture(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, 'node_modules', 'some-package'), {
    recursive: true,
  });
  await fs.mkdir(path.join(dir, 'dist'), {recursive: true});
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
}

afterEach(async () => {
  await Promise.all(
    scratchDirs
      .splice(0)
      .map((dir) => fs.rm(dir, {recursive: true, force: true})),
  );
});

describe('cleanupFixtureProject', () => {
  it('removes the install and build output', async () => {
    const dir = await createScratchDir();
    await seedInstalledFixture(dir);

    await cleanupFixtureProject(dir);

    expect(await exists(path.join(dir, 'node_modules'))).toBe(false);
    expect(await exists(path.join(dir, 'package-lock.json'))).toBe(false);
    expect(await exists(path.join(dir, 'dist'))).toBe(false);
  });
});

describe('installFixtureProject', () => {
  it('names the fixture and keeps the npm failure as the cause', async () => {
    const missingDir = path.join(await createScratchDir(), 'not-created');

    const attempt = installFixtureProject(missingDir);

    await expect(attempt).rejects.toThrow(
      `npm install failed in ${missingDir}`,
    );
    await expect(attempt).rejects.toHaveProperty('cause.code', 'ENOENT');
  });
});
