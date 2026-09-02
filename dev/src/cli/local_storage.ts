/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Persistence for `adk run` under the agent's own `.adk` folder, so a session
 * survives the process without the user naming a database.
 */
import {
  BaseArtifactService,
  BaseSessionService,
  getArtifactServiceFromUri,
  getSessionServiceFromUri,
} from '@google/adk';
import {constants as fsConstants} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {isEnvEnabled} from '../utils/env_utils.js';

const DISABLE_LOCAL_STORAGE_ENV = 'ADK_DISABLE_LOCAL_STORAGE';
const FORCE_LOCAL_STORAGE_ENV = 'ADK_FORCE_LOCAL_STORAGE';
const DOT_ADK_DIR = '.adk';
const SESSION_DB_FILE = 'session.db';
const ARTIFACTS_DIR = 'artifacts';

/** What {@link resolveUseLocalStorage} decided, and why. */
export interface UseLocalStorageDecision {
  useLocalStorage: boolean;

  /** Why the request was refused, for the caller to log once. */
  warning?: string;
}

async function isDirWritable(dir: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) {
      return false;
    }
    await fs.access(dir, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decides whether the run may persist under `<baseDir>/.adk`.
 *
 * Two environment variables override the request, and a directory the process
 * cannot write to refuses it, so a read-only checkout falls back to in-memory
 * services instead of failing the run.
 *
 * @param baseDir The directory that would hold the `.adk` folder.
 * @param requested What the caller asked for.
 */
export async function resolveUseLocalStorage(
  baseDir: string,
  requested: boolean,
): Promise<UseLocalStorageDecision> {
  if (isEnvEnabled(DISABLE_LOCAL_STORAGE_ENV)) {
    return {
      useLocalStorage: false,
      warning:
        `Local storage is disabled by ${DISABLE_LOCAL_STORAGE_ENV}; using ` +
        'in-memory services. Set --session_service_uri/--artifact_service_uri ' +
        'to persist somewhere else.',
    };
  }

  if (isEnvEnabled(FORCE_LOCAL_STORAGE_ENV)) {
    if (await isDirWritable(baseDir)) {
      return {useLocalStorage: true};
    }
    return {
      useLocalStorage: false,
      warning:
        `Local storage is forced by ${FORCE_LOCAL_STORAGE_ENV}, but ` +
        `${baseDir} is not writable; using in-memory services.`,
    };
  }

  if (!requested) {
    return {useLocalStorage: false};
  }

  if (!(await isDirWritable(baseDir))) {
    return {
      useLocalStorage: false,
      warning:
        `Agent directory ${baseDir} is not writable; using in-memory ` +
        `services instead of local ${DOT_ADK_DIR} storage. Set ` +
        `${FORCE_LOCAL_STORAGE_ENV}=1 to force local storage.`,
    };
  }

  return {useLocalStorage: true};
}

async function createDotAdkDir(baseDir: string): Promise<string> {
  const dotAdkDir = path.join(baseDir, DOT_ADK_DIR);
  await fs.mkdir(dotAdkDir, {recursive: true});
  return dotAdkDir;
}

/** Creates the SQLite session service rooted at `<baseDir>/.adk/session.db`. */
export async function createLocalSessionService(
  baseDir: string,
): Promise<BaseSessionService> {
  const dotAdkDir = await createDotAdkDir(baseDir);
  return getSessionServiceFromUri(
    `sqlite://${path.join(dotAdkDir, SESSION_DB_FILE)}`,
  );
}

/** Creates the file artifact service rooted at `<baseDir>/.adk/artifacts`. */
export async function createLocalArtifactService(
  baseDir: string,
): Promise<BaseArtifactService> {
  const dotAdkDir = await createDotAdkDir(baseDir);
  return getArtifactServiceFromUri(
    `file://${path.join(dotAdkDir, ARTIFACTS_DIR)}`,
  );
}
