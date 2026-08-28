/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {AdkLogger} from './logger.js';

const logger = new AdkLogger({label: 'Envs'});

const ADK_DISABLE_LOAD_DOTENV_ENV_VAR = 'ADK_DISABLE_LOAD_DOTENV';

/**
 * The environment variable keys that existed before ADK loaded its first
 * `.env` file. Captured once per process, so a key a `.env` introduces is
 * never mistaken for one the user set.
 */
let explicitEnvKeys: ReadonlySet<string> | undefined;

function getExplicitEnvKeys(): ReadonlySet<string> {
  explicitEnvKeys ??= new Set(Object.keys(process.env));
  return explicitEnvKeys;
}

/**
 * An environment variable counts as enabled when its value is `true` or `1`,
 * in any case. Matches `is_env_enabled` in adk-python.
 */
function isEnvEnabled(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === 'true' || value === '1';
}

/**
 * Returns the path of the nearest `filename` at or above `startFolder`, or
 * `undefined` when the walk reaches the filesystem root without a hit.
 *
 * `statSync` with `throwIfNoEntry: false` answers "missing" and "the parent is
 * not a directory" with `undefined`, and still throws on a real fault such as
 * `EACCES`, which must not be hidden.
 */
function findFileUpwards(
  startFolder: string,
  filename: string,
): string | undefined {
  let folder = startFolder;

  for (;;) {
    const candidate = path.join(folder, filename);
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
 * The search starts at `<agentParentFolder>/<agentName>` and walks up to the
 * filesystem root. A value the user set explicitly, before the first `.env`
 * was loaded, always wins. A value that came from an earlier `.env` does not,
 * so each agent gets its own file. Setting `ADK_DISABLE_LOAD_DOTENV` to `1` or
 * `true` turns the whole thing off.
 *
 * @param agentName The agent's folder or file name. May be empty to start the
 *   walk at `agentParentFolder` itself.
 * @param agentParentFolder The folder holding the agent, resolved against the
 *   working directory when relative.
 * @param filename The file to look for.
 */
export function loadDotenvForAgent(
  agentName: string,
  agentParentFolder: string,
  filename = '.env',
): void {
  if (isEnvEnabled(ADK_DISABLE_LOAD_DOTENV_ENV_VAR)) {
    logger.debug(
      `Skipping ${filename} loading because ${ADK_DISABLE_LOAD_DOTENV_ENV_VAR} is enabled.`,
    );
    return;
  }

  const startFolder = path.resolve(agentParentFolder, agentName);
  const dotenvPath = findFileUpwards(startFolder, filename);
  if (!dotenvPath) {
    logger.debug(`No ${filename} file found for ${agentName}`);
    return;
  }

  const explicitEnv: Array<[string, string]> = [];
  for (const key of getExplicitEnvKeys()) {
    const value = process.env[key];
    if (value !== undefined) {
      explicitEnv.push([key, value]);
    }
  }

  dotenv.config({path: dotenvPath, override: true, quiet: true});

  for (const [key, value] of explicitEnv) {
    process.env[key] = value;
  }

  logger.debug(`Loaded ${filename} file for ${agentName} at ${dotenvPath}`);
}
