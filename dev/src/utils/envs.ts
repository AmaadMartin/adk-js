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
 * The snapshot is taken when this module is evaluated. Every ADK `.env` load
 * goes through a function declared here, and an ES module runs its imports
 * before its own body, so the module that performs a load has always evaluated
 * this one first. The snapshot therefore precedes every load, whatever order
 * the CLI imports its modules in.
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

/**
 * Reports whether `candidate` is a readable file.
 *
 * A path the process may not stat (`EACCES` on an ancestor directory) counts
 * as absent, so one unreadable directory cannot stop the walk.
 */
function isReadableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate, {throwIfNoEntry: false})?.isFile() ?? false;
  } catch {
    return false;
  }
}

/** Returns the first `filename` found in `folder` or an ancestor of it. */
function walkToRootUntilFound(folder: string, filename: string): string {
  let current = folder;

  for (;;) {
    const candidate = path.join(current, filename);
    if (isReadableFile(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return '';
    }
    current = parent;
  }
}

/** Reports whether the environment forbids reading any `.env` file. */
function isDotenvLoadDisabled(filename: string): boolean {
  if (!getBooleanEnvVar(DISABLE_LOAD_DOTENV_ENV_VAR)) {
    return false;
  }
  logger.debug(
    `Skipping ${filename} loading because ${DISABLE_LOAD_DOTENV_ENV_VAR} is enabled.`,
  );
  return true;
}

/**
 * Applies `dotenvPath` to `process.env`, then gives back the values of the
 * variables the user exported.
 *
 * @param subject What the file was loaded for, named in the log line.
 */
function applyDotenvFile(
  dotenvPath: string,
  subject: string,
  filename: string,
): void {
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
    logger.debug(`Loaded ${filename} file for ${subject} at ${dotenvPath}`);
  } catch (error: unknown) {
    // The path is safe to log; the values in the file are not.
    logger.warn(
      `Failed to load ${filename} for ${subject} at ${dotenvPath}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    Object.assign(process.env, explicitEnv);
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
  if (isDotenvLoadDisabled(filename)) {
    return;
  }

  const startFolder = path.resolve(agentParentDir, agentName);
  const dotenvPath = walkToRootUntilFound(startFolder, filename);
  if (!dotenvPath) {
    logger.debug(`No ${filename} file found for ${agentName}`);
    return;
  }

  applyDotenvFile(dotenvPath, agentName, filename);
}

/**
 * Applies the `.env` of the working directory to `process.env`.
 *
 * This is the load every `adk` command performs at start-up. It obeys
 * `ADK_DISABLE_LOAD_DOTENV`, so a pipeline that sets the flag runs with no
 * value from a checked-in file. A later {@link loadDotenvForAgent} overrides
 * whatever this load set, and neither one overwrites a variable the user
 * exported.
 *
 * @param filename Name of the environment file to look for.
 */
export function loadDotenvFromCwd(filename = '.env'): void {
  if (isDotenvLoadDisabled(filename)) {
    return;
  }

  const dotenvPath = path.resolve(process.cwd(), filename);
  if (!isReadableFile(dotenvPath)) {
    logger.debug(`No ${filename} file found in the working directory`);
    return;
  }

  applyDotenvFile(dotenvPath, 'the working directory', filename);
}
