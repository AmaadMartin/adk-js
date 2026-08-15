/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// sqlite3 5.1.7 publishes napi-v3 and napi-v6 assets (binary.napi_versions);
// prebuild-install picks 6, the highest one the runner Node can load.
const NAPI_BUILD_VERSION = 6;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
const LOCKFILE = new URL('../package-lock.json', import.meta.url);

function warn(message) {
  process.stdout.write(`::warning::${message}\n`);
}

async function readSqlite3Version() {
  const lockfile = JSON.parse(await readFile(LOCKFILE, 'utf8'));
  return lockfile.packages?.['node_modules/sqlite3']?.version;
}

async function fetchTarball(url) {
  let attempt = 0;
  let lastError;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await delay(RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}

const destination = process.env.npm_config_sqlite3_local_prebuilds;
if (!destination) {
  process.stderr.write('npm_config_sqlite3_local_prebuilds is not set.\n');
  process.exit(1);
}

const version = await readSqlite3Version();
if (!version) {
  warn('package-lock.json has no sqlite3 entry, so there is nothing to fetch.');
  process.exit(0);
}

const asset = `sqlite3-v${version}-napi-v${NAPI_BUILD_VERSION}-${process.platform}-${process.arch}.tar.gz`;
const url = `https://github.com/TryGhost/node-sqlite3/releases/download/v${version}/${asset}`;
const target = path.join(destination, asset);

try {
  await mkdir(destination, {recursive: true});
  const tarball = await fetchTarball(url);
  await writeFile(target, tarball);
  process.stdout.write(`Prefetched ${url} (${tarball.length} bytes)\n`);
} catch (error) {
  warn(
    `Could not prefetch ${url}: ${error.message}. npm install downloads it.`,
  );
}
