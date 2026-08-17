/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseArtifactService, BaseSessionService} from '@google/adk';
import {
  InMemoryArtifactService,
  InMemorySessionService,
  getArtifactServiceFromUri,
  getSessionServiceFromUri,
} from '@google/adk';
import {constants as fsConstants} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {isFile} from './file_utils.js';
import {
  PerAgentDatabaseSessionService,
  PerAgentFileArtifactService,
} from './local_storage.js';
import {AdkLogger} from './logger.js';

const logger = new AdkLogger({label: 'ServiceFactory', colorize: {all: true}});

const FORCE_LOCAL_STORAGE_ENV = 'ADK_FORCE_LOCAL_STORAGE';
const CLOUD_RUN_SERVICE_ENV = 'K_SERVICE';
const KUBERNETES_HOST_ENV = 'KUBERNETES_SERVICE_HOST';

/** Returns true when the environment variable is set to `1` or `true`. */
export function isEnvFlagEnabled(name: string): boolean {
  const value = process.env[name]?.toLowerCase();

  return value === '1' || value === 'true';
}

/** Returns true when `dir` exists, is a directory, and accepts writes. */
export async function isDirWritable(dir: string): Promise<boolean> {
  try {
    if (!(await fs.stat(dir)).isDirectory()) {
      return false;
    }
    await fs.access(dir, fsConstants.W_OK | fsConstants.X_OK);

    return true;
  } catch (_e: unknown) {
    return false;
  }
}

/** Whether to persist under `.adk`, and why not when the answer is no. */
export interface LocalStorageDecision {
  useLocalStorage: boolean;
  /** Set only when local storage was requested and refused. */
  warning?: string;
}

/**
 * Decides whether the CLI may persist to `<agent>/.adk`.
 *
 * The branch order is the behaviour: `ADK_FORCE_LOCAL_STORAGE` deliberately
 * skips the container check, so an operator can opt a container back in.
 */
export async function resolveUseLocalStorage(options: {
  baseDir: string;
  requested: boolean;
}): Promise<LocalStorageDecision> {
  const {baseDir, requested} = options;

  if (isEnvFlagEnabled(FORCE_LOCAL_STORAGE_ENV)) {
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

  if (process.env[CLOUD_RUN_SERVICE_ENV] || process.env[KUBERNETES_HOST_ENV]) {
    return {
      useLocalStorage: false,
      warning:
        `Detected a Cloud Run or Kubernetes runtime; using in-memory ` +
        `services instead of local .adk storage, because a container disk ` +
        `does not survive a restart. Set ${FORCE_LOCAL_STORAGE_ENV}=1 to ` +
        `force local storage.`,
    };
  }

  if (!(await isDirWritable(baseDir))) {
    return {
      useLocalStorage: false,
      warning:
        `Agents directory ${baseDir} is not writable; using in-memory ` +
        `services instead of local .adk storage. Set ` +
        `${FORCE_LOCAL_STORAGE_ENV}=1 to force local storage.`,
    };
  }

  return {useLocalStorage: true};
}

/**
 * Returns the directory that holds the agents.
 *
 * `agentsDir` is `agents_dir` as given on the command line, which may point at
 * a single agent file rather than at a directory of agents.
 */
export async function resolveAgentsRoot(agentsDir: string): Promise<string> {
  return (await isFile(agentsDir)) ? path.dirname(agentsDir) : agentsDir;
}

async function shouldUseLocalStorage(
  baseDir: string,
  requested: boolean,
): Promise<boolean> {
  const decision = await resolveUseLocalStorage({baseDir, requested});
  if (decision.warning) {
    logger.warn(decision.warning);
  }

  return decision.useLocalStorage;
}

/** Creates the session service for `adk web` and `adk api_server`. */
export async function createSessionServiceFromOptions(options: {
  baseDir: string;
  sessionServiceUri?: string;
  useLocalStorage?: boolean;
}): Promise<BaseSessionService> {
  const {baseDir, sessionServiceUri, useLocalStorage = true} = options;

  if (sessionServiceUri) {
    return getSessionServiceFromUri(sessionServiceUri);
  }

  if (!(await shouldUseLocalStorage(baseDir, useLocalStorage))) {
    return new InMemorySessionService();
  }

  return new PerAgentDatabaseSessionService({agentsRoot: baseDir});
}

/** Creates the artifact service for `adk web` and `adk api_server`. */
export async function createArtifactServiceFromOptions(options: {
  baseDir: string;
  artifactServiceUri?: string;
  useLocalStorage?: boolean;
}): Promise<BaseArtifactService> {
  const {baseDir, artifactServiceUri, useLocalStorage = true} = options;

  if (artifactServiceUri) {
    return getArtifactServiceFromUri(artifactServiceUri);
  }

  if (!(await shouldUseLocalStorage(baseDir, useLocalStorage))) {
    return new InMemoryArtifactService();
  }

  return new PerAgentFileArtifactService({agentsRoot: baseDir});
}
