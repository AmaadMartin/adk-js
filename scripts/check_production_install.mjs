/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Asserts that every package a published workspace declares under
 * `dependencies` is present in the installed tree.
 *
 * Run it after `npm ci --omit=dev` to prove that a consumer of the published
 * packages gets everything the runtime imports: a lockfile can be perfectly
 * self-consistent and still resolve a runtime dependency to a node that a
 * production install prunes.
 *
 * This validates the manifest -> installed tree direction only. A package that
 * `src` imports but no manifest declares is never in the iteration set, so it
 * is not caught here.
 *
 * Usage: node scripts/check_production_install.mjs [rootDir]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * The subset of an npm manifest this check reads.
 *
 * @typedef {object} Manifest
 * @property {string[]} [workspaces] Workspace directories, root manifest only.
 * @property {Record<string, string>} [dependencies] Production dependencies.
 */

/**
 * @param {string} manifestPath
 * @returns {Manifest}
 */
function readManifest(manifestPath) {
  let contents;
  try {
    contents = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${manifestPath}: ${error.message}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Cannot parse ${manifestPath}: ${error.message}`);
  }
}

/**
 * Whether `candidate` is a directory, following symlinks: npm links workspace
 * packages into `node_modules`, so an `lstat` would reject a healthy tree.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isDirectory(candidate) {
  return (
    fs.statSync(candidate, {throwIfNoEntry: false})?.isDirectory() === true
  );
}

/**
 * The locations npm may install `name` for `workspace`: nested under the
 * workspace when versions conflict, hoisted to the root otherwise.
 *
 * @param {string} rootDir
 * @param {string} workspace
 * @param {string} name
 * @returns {string[]}
 */
function candidatePaths(rootDir, workspace, name) {
  return [
    path.join(rootDir, workspace, 'node_modules', name),
    path.join(rootDir, 'node_modules', name),
  ];
}

/**
 * @param {string[]} argv
 * @returns {number} The process exit code.
 */
function main(argv) {
  const rootDir = path.resolve(argv[0] ?? process.cwd());
  const rootManifestPath = path.join(rootDir, 'package.json');
  const {workspaces} = readManifest(rootManifestPath);
  if (!Array.isArray(workspaces)) {
    throw new Error(`${rootManifestPath} declares no "workspaces" array.`);
  }

  const unresolved = [];
  let checked = 0;
  for (const workspace of workspaces) {
    if (workspace.includes('*')) {
      throw new Error(
        `Unsupported glob in workspace entry "${workspace}". This check ` +
          `resolves workspace paths literally, so it would silently verify ` +
          `nothing for every package the glob matches. Teach it to expand ` +
          `globs before declaring one.`,
      );
    }
    const {dependencies} = readManifest(
      path.join(rootDir, workspace, 'package.json'),
    );
    for (const name of Object.keys(dependencies ?? {})) {
      checked += 1;
      const candidates = candidatePaths(rootDir, workspace, name);
      if (!candidates.some(isDirectory)) {
        unresolved.push(
          `${workspace}: "${name}" is declared under dependencies but is ` +
            `installed at neither ${candidates[0]} nor ${candidates[1]}.`,
        );
      }
    }
  }

  if (unresolved.length > 0) {
    process.stderr.write(`${unresolved.join('\n')}\n`);
    process.stderr.write(
      `::error::${unresolved.length} of ${checked} declared production ` +
        `dependencies are missing after a production install. Move each one ` +
        `out of devDependencies into the dependencies block of the workspace ` +
        `that imports it at runtime, then re-run npm install so ` +
        `package-lock.json records it as a production node.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `Verified ${checked} production dependencies across ` +
      `${workspaces.length} workspaces.\n`,
  );
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`::error::${error.message}\n`);
  process.exitCode = 1;
}
