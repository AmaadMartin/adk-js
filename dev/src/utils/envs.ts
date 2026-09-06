/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar} from '@google/adk';
import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {AdkLogger} from './logger.js';

const logger = new AdkLogger({label: 'Envs', colorize: {all: true}});

/** Set this to `1` or `true` to stop the CLI reading any `.env` file. */
const DISABLE_LOAD_DOTENV_ENV_VAR = 'ADK_DISABLE_LOAD_DOTENV';

/**
 * The variables the user exported before this process loaded any `.env`.
 *
 * The snapshot is taken when this module is evaluated. An ES module runs its
 * imports before the body of the module that imported it, so this list is
 * captured before the CLI loads the `.env` of the working directory.
 */
const EXPLICIT_ENV_KEYS = new Set(Object.keys(process.env));

/** Returns the values the explicit variables hold right now. */
function readExplicitEnv(): Record<string, string> {
  const explicit: Record<string, string> = {};
  for (const key of EXPLICIT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      explicit[key] = value;
    }
  }
  return explicit;
}

/** Returns the first `filename` found in `folder` or an ancestor of it. */
function walkToRootUntilFound(folder: string, filename: string): string {
  let current = folder;

  for (;;) {
    const candidate = path.join(current, filename);
    if (fs.statSync(candidate, {throwIfNoEntry: false})?.isFile()) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return '';
    }
    current = parent;
  }
}

/**
 * Applies the `.env` nearest to the agent to `process.env`.
 *
 * The search starts at `<agentParentDir>/<agentName>` and climbs to the
 * filesystem root. A variable the user exported keeps its value: the file can
 * only add variables and override what an earlier `.env` set. A missing or
 * unreadable file leaves the run unaffected.
 *
 * @param agentName Name the agent is served under, normally its folder name.
 * @param agentParentDir Directory that contains the agent.
 * @param filename Name of the environment file to look for.
 */
export function loadDotenvForAgent(
  agentName: string,
  agentParentDir: string,
  filename = '.env',
): void {
  if (getBooleanEnvVar(DISABLE_LOAD_DOTENV_ENV_VAR)) {
    logger.debug(
      `Skipping ${filename} loading because ${DISABLE_LOAD_DOTENV_ENV_VAR} is enabled.`,
    );
    return;
  }

  const startFolder = path.resolve(agentParentDir, agentName);
  const dotenvPath = walkToRootUntilFound(startFolder, filename);
  if (!dotenvPath) {
    logger.debug(`No ${filename} file found for ${agentName}`);
    return;
  }

  const explicitEnv = readExplicitEnv();
  try {
    const {error} = dotenv.config({
      path: dotenvPath,
      override: true,
      quiet: true,
    });
    if (error) {
      throw error;
    }
    logger.debug(`Loaded ${filename} file for ${agentName} at ${dotenvPath}`);
  } catch (error: unknown) {
    // The path is safe to log; the values in the file are not.
    logger.warn(
      `Failed to load ${filename} for ${agentName} at ${dotenvPath}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    Object.assign(process.env, explicitEnv);
  }
}
