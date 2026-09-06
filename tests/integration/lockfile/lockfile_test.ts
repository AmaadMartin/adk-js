/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const REPO_ROOT = process.cwd();

/** The subset of an npm manifest this test reads. */
interface Manifest {
  workspaces?: string[];
  dependencies?: Record<string, string>;
}

/** The subset of a `lockfileVersion: 3` package entry this test reads. */
interface LockNode {
  dev?: boolean;
}

interface Lockfile {
  packages: Record<string, LockNode>;
}

function readJson<T>(...segments: string[]): T {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, ...segments), 'utf8'),
  ) as T;
}

/** Keys of the lockfile nodes `npm ci --omit=dev` installs for `name`. */
function productionNodesFor(lock: Lockfile, name: string): string[] {
  const hoisted = `node_modules/${name}`;
  return Object.keys(lock.packages).filter(
    (key) =>
      (key === hoisted || key.endsWith(`/${hoisted}`)) &&
      lock.packages[key].dev !== true,
  );
}

const lock = readJson<Lockfile>('package-lock.json');
const workspaces = readJson<Manifest>('package.json').workspaces ?? [];

describe('package-lock.json', () => {
  describe.each(workspaces)('%s production dependencies', (workspace) => {
    const dependencies = Object.keys(
      readJson<Manifest>(workspace, 'package.json').dependencies ?? {},
    );

    it.each(dependencies)('%s survives npm ci --omit=dev', (name) => {
      expect(
        productionNodesFor(lock, name),
        `${name} is a production dependency of ${workspace}, but ` +
          `package-lock.json holds no node for it that npm ci --omit=dev ` +
          `installs: it is either absent or marked "dev": true everywhere. ` +
          `Re-run npm install --package-lock-only.`,
      ).not.toHaveLength(0);
    });
  });
});
