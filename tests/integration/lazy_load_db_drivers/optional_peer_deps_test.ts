/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * The MikroORM SQL drivers `DatabaseSessionService` resolves through a dynamic
 * import, so npm must not install them for consumers that never open a
 * database connection.
 */
const OPTIONAL_DRIVERS = [
  '@mikro-orm/mariadb',
  '@mikro-orm/mssql',
  '@mikro-orm/mysql',
  '@mikro-orm/postgresql',
  '@mikro-orm/sqlite',
];

const REPO_ROOT = process.cwd();
const CORE_MANIFEST = path.join(REPO_ROOT, 'core', 'package.json');
const ROOT_LOCKFILE = path.join(REPO_ROOT, 'package-lock.json');

interface Manifest {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, {optional?: boolean}>;
}

interface Lockfile {
  packages: Record<string, Manifest>;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

describe('Optional DB driver peer dependencies', () => {
  it.each(OPTIONAL_DRIVERS)(
    'declares %s as an optional peer dependency of @google/adk',
    async (driver) => {
      const manifest = await readJson<Manifest>(CORE_MANIFEST);

      expect(manifest.peerDependencies?.[driver]).toBeDefined();
      expect(manifest.peerDependenciesMeta?.[driver]?.optional).toBe(true);
    },
  );

  it('gives every peer dependency a peerDependenciesMeta entry', async () => {
    const manifest = await readJson<Manifest>(CORE_MANIFEST);

    expect(Object.keys(manifest.peerDependenciesMeta ?? {}).sort()).toEqual(
      Object.keys(manifest.peerDependencies ?? {}).sort(),
    );
  });

  it('mirrors peerDependenciesMeta into package-lock.json', async () => {
    const [manifest, lockfile] = await Promise.all([
      readJson<Manifest>(CORE_MANIFEST),
      readJson<Lockfile>(ROOT_LOCKFILE),
    ]);

    expect(lockfile.packages['core'].peerDependenciesMeta).toEqual(
      manifest.peerDependenciesMeta,
    );
  });
});
