/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** This file lives in tests/integration/release/, three levels below the root. */
const REPO_ROOT = path.resolve(__dirname, '../../..');

const MANIFEST = '.release-please-manifest.json';
const CONFIG = 'release-please-config.json';

/**
 * release-please package path (as keyed in release-please-config.json and
 * .release-please-manifest.json) -> its component name in the linked-versions
 * group. Every package released with the group must be listed here.
 */
const LINKED_PACKAGES = {
  '.': 'main',
  core: 'adk',
  dev: 'devtools',
  integrations: 'integrations',
} as const;

/** Semver core with an optional prerelease suffix. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Narrows a parsed file so callers can index it without a cast. */
function readJsonObject(relativePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.resolve(REPO_ROOT, relativePath), 'utf8'),
  );
  if (!isJsonObject(parsed)) {
    expect.fail(`Expected ${relativePath} to hold a JSON object`);
  }
  return parsed;
}

describe('release version consistency', () => {
  it('pins every package.json and the release-please manifest to the same version', () => {
    const manifest = readJsonObject(MANIFEST);
    const versions: Record<string, unknown> = {};
    for (const pkg of Object.keys(LINKED_PACKAGES)) {
      const pkgJson = path.join(pkg, 'package.json');
      versions[pkgJson] = readJsonObject(pkgJson).version;
      versions[`${MANIFEST}#${pkg}`] = manifest[pkg];
    }

    // Guards the equality below from passing vacuously on a malformed value.
    const rootVersion = versions['package.json'];
    expect(rootVersion).toMatch(VERSION_PATTERN);

    // Compared as one record so the diff names every file that drifted, not
    // just the first one.
    expect(versions).toEqual(
      Object.fromEntries(
        Object.keys(versions).map((source) => [source, rootVersion]),
      ),
    );
  });

  it('checks every package in the release-please linked-versions group', () => {
    const config = readJsonObject(CONFIG);
    const packagePaths = Object.keys(LINKED_PACKAGES).sort();

    const packages = config.packages;
    if (!isJsonObject(packages)) {
      expect.fail(`Expected "packages" to be an object in ${CONFIG}`);
    }
    expect(Object.keys(packages).sort()).toEqual(packagePaths);
    expect(Object.keys(readJsonObject(MANIFEST)).sort()).toEqual(packagePaths);

    expect(packages).toEqual(
      Object.fromEntries(
        Object.entries(LINKED_PACKAGES).map(([pkg, component]) => [
          pkg,
          expect.objectContaining({component}),
        ]),
      ),
    );

    const plugins = config.plugins;
    if (!isJsonArray(plugins)) {
      expect.fail(`Expected "plugins" to be an array in ${CONFIG}`);
    }
    const linkedVersions = plugins.find(
      (plugin) => isJsonObject(plugin) && plugin.type === 'linked-versions',
    );
    if (!isJsonObject(linkedVersions)) {
      expect.fail(`Expected a "linked-versions" plugin in ${CONFIG}`);
    }
    const linkedComponents = linkedVersions.components;
    if (!isJsonArray(linkedComponents)) {
      expect.fail(`Expected "components" to be an array in ${CONFIG}`);
    }
    expect([...linkedComponents].sort()).toEqual(
      Object.values(LINKED_PACKAGES).sort(),
    );
  });
});
