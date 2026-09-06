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
 * The keys a `.env` supplied. Every other key in `process.env` belongs to the
 * user, so a `.env` may replace one of these and nothing else. The working
 * directory `.env` is loaded through this module too, which is why an agent's
 * own file can still override it.
 */
const dotenvKeys = new Set<string>();

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
    if (!(key in process.env) || dotenvKeys.has(key)) {
      process.env[key] = value;
      dotenvKeys.add(key);
    }
  }

  getLogger().debug(`Loaded .env file for ${agentName} at ${dotenvPath}`);
}
