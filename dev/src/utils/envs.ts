/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getLogger} from '@google/adk';
import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ADK_DISABLE_LOAD_DOTENV_ENV_VAR = 'ADK_DISABLE_LOAD_DOTENV';

/**
 * The environment variable keys the process started with.
 *
 * Captured while this module is evaluated. Every `.env` the CLI reads goes
 * through this module, and under ESM a module runs before the code that
 * imports it, so these are the keys the user set and nothing else. Capturing
 * them at the first load instead would count the working directory `.env` that
 * `cli.ts` applies at startup, and that file would then outrank every agent's
 * own `.env`.
 */
const EXPLICIT_ENV_KEYS: ReadonlySet<string> = new Set(
  Object.keys(process.env),
);

/**
 * Returns the path of the nearest `.env` at or above `startPath`, or
 * `undefined` when the walk reaches the filesystem root without a hit.
 *
 * `statSync` with `throwIfNoEntry: false` answers "missing" and "the parent is
 * not a directory" with `undefined`, and still throws on a real fault such as
 * `EACCES`, which must not be hidden.
 */
function findDotenvUpwards(startPath: string): string | undefined {
  let folder = startPath;

  for (;;) {
    const candidate = path.join(folder, '.env');
    if (fs.statSync(candidate, {throwIfNoEntry: false})?.isFile()) {
      return candidate;
    }

    const parent = path.dirname(folder);
    if (parent === folder) {
      return undefined;
    }
    folder = parent;
  }
}

/**
 * Loads the `.env` file that belongs to an agent into `process.env`.
 *
 * The search starts at `agentPath` and walks up to the filesystem root. A
 * value the user set explicitly, before the first `.env` was loaded, always
 * wins. A value that came from an earlier `.env` does not, so each agent gets
 * its own file. Setting `ADK_DISABLE_LOAD_DOTENV` to `1` or `true` turns the
 * whole thing off.
 *
 * @param agentPath The agent's folder or file, resolved against the working
 *   directory when relative.
 */
export function loadDotenvForAgent(agentPath: string): void {
  const disableFlag =
    process.env[ADK_DISABLE_LOAD_DOTENV_ENV_VAR]?.toLowerCase();
  if (disableFlag === 'true' || disableFlag === '1') {
    getLogger().debug(
      `Skipping .env loading because ${ADK_DISABLE_LOAD_DOTENV_ENV_VAR} is enabled.`,
    );
    return;
  }

  const agentName = path.basename(agentPath);
  const dotenvPath = findDotenvUpwards(path.resolve(agentPath));
  if (!dotenvPath) {
    getLogger().debug(`No .env file found for ${agentName}`);
    return;
  }

  const parsed = dotenv.parse(fs.readFileSync(dotenvPath));
  for (const [key, value] of Object.entries(parsed)) {
    // A key the caller has since deleted is no longer set explicitly, so the
    // file supplies it again.
    if (!EXPLICIT_ENV_KEYS.has(key) || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  getLogger().debug(`Loaded .env file for ${agentName} at ${dotenvPath}`);
}

/** The loads already queued, so a new one waits for them. */
let queuedLoads: Promise<unknown> = Promise.resolve();

/**
 * Applies an agent's `.env`, then runs `load` before any other agent's `.env`
 * can be applied.
 *
 * `process.env` holds one agent's values at a time, and an agent module reads
 * them while it is imported. A caller that loads several agents at once must
 * therefore not interleave them: the second agent's `.env` would land while
 * the first agent is still being imported, and both agents would read the
 * second file. Loads run one after another to keep each agent on its own
 * `.env`.
 *
 * @param agentPath The agent's folder or file.
 * @param load Imports the agent. It runs with the agent's `.env` applied.
 */
export function withAgentDotenv<T>(
  agentPath: string,
  load: () => Promise<T>,
): Promise<T> {
  const loaded = queuedLoads.then(() => {
    loadDotenvForAgent(agentPath);
    return load();
  });
  // The caller owns this failure. Swallow it here so one agent that fails to
  // load does not reject every agent queued behind it.
  queuedLoads = loaded.catch(() => {});
  return loaded;
}
