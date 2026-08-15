/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {spawnSync} from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, describe, expect, it} from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT_NAME = 'prefetch_sqlite3_prebuild.mjs';
const SCRIPT = path.join(REPO_ROOT, 'scripts', SCRIPT_NAME);
const DEST_ENV_VAR = 'npm_config_sqlite3_local_prebuilds';

/** The napi build version the script requests, and prebuild-install selects. */
const NAPI_BUILD_VERSION = 6;

/** The script backs off 2s and then 4s over its three attempts. */
const MIN_RETRY_ELAPSED_MS = 5000;

/** The one lockfile shape the script reads. */
interface Lockfile {
  packages: Record<string, {version: string}>;
}

const lockfile: Lockfile = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'package-lock.json'), 'utf8'),
);
const sqlite3Version = lockfile.packages['node_modules/sqlite3'].version;

const tempRoot = mkdtempSync(path.join(tmpdir(), 'adk-sqlite3-prefetch-'));

afterAll(() => {
  rmSync(tempRoot, {recursive: true, force: true});
});

/** Returns a fresh path under the temp root, without creating it. */
function reservePath(name: string) {
  return path.join(mkdtempSync(path.join(tempRoot, 'case-')), name);
}

/**
 * Copies the script into a throwaway tree beside the given lockfile, so the
 * lockfile the script reads can be varied without touching the repository.
 */
function sandboxScript(contents: Lockfile) {
  const root = mkdtempSync(path.join(tempRoot, 'sandbox-'));
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify(contents),
    'utf8',
  );
  const script = path.join(root, 'scripts', SCRIPT_NAME);
  copyFileSync(SCRIPT, script);
  return script;
}

function runPrefetch(script: string, destination: string | undefined) {
  const env = {...process.env};
  if (destination === undefined) {
    delete env[DEST_ENV_VAR];
  } else {
    env[DEST_ENV_VAR] = destination;
  }
  return spawnSync(process.execPath, [script], {encoding: 'utf8', env});
}

describe('prefetch_sqlite3_prebuild', () => {
  it('writes the tarball prebuild-install looks for locally', () => {
    const destination = reservePath('prebuilds');

    const result = runPrefetch(SCRIPT, destination);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(readdirSync(destination)).toEqual([
      `sqlite3-v${sqlite3Version}-napi-v${NAPI_BUILD_VERSION}-${process.platform}-${process.arch}.tar.gz`,
    ]);
  });

  it('fails when the destination directory is not configured', () => {
    const result = runPrefetch(SCRIPT, undefined);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(DEST_ENV_VAR);
  });

  it('skips the download when the lockfile has no sqlite3 entry', () => {
    const script = sandboxScript({packages: {}});
    const destination = reservePath('prebuilds');

    const result = runPrefetch(script, destination);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::');
    expect(existsSync(destination)).toBe(false);
  });

  it('retries, then warns, when the release asset is missing', () => {
    const script = sandboxScript({
      packages: {'node_modules/sqlite3': {version: '0.0.0-absent'}},
    });
    const destination = reservePath('prebuilds');

    const startedAt = Date.now();
    const result = runPrefetch(script, destination);
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::');
    expect(elapsed).toBeGreaterThanOrEqual(MIN_RETRY_ELAPSED_MS);
    expect(readdirSync(destination)).toEqual([]);
  });

  it('warns when the destination cannot be created', () => {
    const destination = reservePath('a-file');
    writeFileSync(destination, '', 'utf8');

    const result = runPrefetch(SCRIPT, destination);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::');
  });
});
