/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {
  cleanFixture,
  FIXTURE_PROJECT_DIRS,
  installFixture,
} from './fixture_installs.js';

const INTEGRATION_ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * The two `fake-onnxruntime-node` packages are `file:` dependencies of their
 * parent fixture, so the parent's install builds them. They are the only
 * manifests under `tests/integration` that must not be installed on their own.
 */
const NESTED_LOCAL_PACKAGE_DIRS = [
  'build_setup/ts_commonjs_native_addon/fake-onnxruntime-node',
  'build_setup/ts_esm_native_addon/fake-onnxruntime-node',
].map((project) => path.join(INTEGRATION_ROOT, project));

const tempDirs: string[] = [];

async function makeTempProject(manifest: object): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-fixture-'));
  tempDirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({name: 'temp-fixture', version: '1.0.0', ...manifest}),
  );
  return dir;
}

/** Directories under `root` that hold a `package.json`, ignoring installs. */
async function findManifestDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(root, {withFileTypes: true})) {
    if (entry.name === 'node_modules') {
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...(await findManifestDirs(path.join(root, entry.name))));
    } else if (entry.name === 'package.json') {
      found.push(root);
    }
  }
  return found;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, {recursive: true, force: true})),
  );
});

describe('FIXTURE_PROJECT_DIRS', () => {
  it('points every entry at a project directory', async () => {
    for (const dir of FIXTURE_PROJECT_DIRS) {
      const manifest = await fs.readFile(
        path.join(dir, 'package.json'),
        'utf-8',
      );
      expect(JSON.parse(manifest).name, dir).toBeTruthy();
    }
  });

  it('registers every fixture project on disk', async () => {
    const onDisk = await findManifestDirs(INTEGRATION_ROOT);

    expect(onDisk.sort()).toEqual(
      [...FIXTURE_PROJECT_DIRS, ...NESTED_LOCAL_PACKAGE_DIRS].sort(),
    );
  });
});

describe('installFixture', () => {
  it('writes a lockfile for a dependency-free project', async () => {
    const dir = await makeTempProject({});

    installFixture(dir);

    await expect(
      fs.access(path.join(dir, 'package-lock.json')),
    ).resolves.toBeUndefined();
  });

  it('throws when npm cannot resolve a dependency', async () => {
    const dir = await makeTempProject({
      dependencies: {missing: 'file:./does-not-exist'},
    });

    expect(() => installFixture(dir)).toThrow();
  });
});

describe('cleanFixture', () => {
  it('removes the installed node_modules and the lockfile', async () => {
    const dir = await makeTempProject({});
    await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), {recursive: true});
    await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), '');
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');

    await cleanFixture(dir);

    await expect(fs.access(path.join(dir, 'node_modules'))).rejects.toThrow();
    await expect(
      fs.access(path.join(dir, 'package-lock.json')),
    ).rejects.toThrow();
  });

  it('does nothing when the project has no install artefacts', async () => {
    const dir = await makeTempProject({});

    await expect(cleanFixture(dir)).resolves.toBeUndefined();
  });

  it('swallows a removal error', async () => {
    const dir = await makeTempProject({});
    const notADirectory = path.join(dir, 'package.json');

    await expect(cleanFixture(notADirectory)).resolves.toBeUndefined();
  });
});
