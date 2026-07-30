/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import {createRequire} from 'node:module';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

const repoRoot = process.cwd();
const require = createRequire(path.join(repoRoot, 'package.json'));

const NESTED_LOCK_PATH =
  'node_modules/@google-cloud/vertexai/node_modules/google-auth-library';

interface Lockfile {
  packages: Record<string, unknown>;
}

interface RootManifest {
  overrides?: Record<string, Record<string, string>>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'),
  ) as T;
}

/** Resolves google-auth-library's manifest as `dependentDir` sees it. */
function resolveAuthLibraryManifest(dependentDir: string): string {
  return require.resolve('google-auth-library/package.json', {
    paths: [path.join(repoRoot, dependentDir)],
  });
}

describe('google-auth-library deduplication', () => {
  it('pins the @google-cloud/vertexai override in the root manifest', () => {
    const manifest = readJson<RootManifest>('package.json');
    expect(
      manifest.overrides?.['@google-cloud/vertexai']?.['google-auth-library'],
    ).toBe('^10.3.0');
  });

  it('does not lock a nested google-auth-library under @google-cloud/vertexai', () => {
    const lockfile = readJson<Lockfile>('package-lock.json');
    expect(Object.keys(lockfile.packages)).not.toContain(NESTED_LOCK_PATH);
  });

  it('resolves one google-auth-library 10.x for vertexai, genai and adk core', () => {
    const hoisted = resolveAuthLibraryManifest('core');
    const version = (
      JSON.parse(fs.readFileSync(hoisted, 'utf8')) as {version: string}
    ).version;
    expect(version.startsWith('10.')).toBe(true);
    expect(
      resolveAuthLibraryManifest('node_modules/@google-cloud/vertexai'),
    ).toBe(hoisted);
    expect(resolveAuthLibraryManifest('core/node_modules/@google/genai')).toBe(
      hoisted,
    );
  });
});
