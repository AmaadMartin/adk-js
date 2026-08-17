/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

const DOT_ADK_DIR_NAME = '.adk';
const ARTIFACTS_DIR_NAME = 'artifacts';
const SESSION_DB_FILE_NAME = 'session.db';

/** Resolves the paths ADK persists under a single agent's `.adk` folder. */
export class DotAdkFolder {
  /** The agent directory that holds the `.adk` folder. */
  readonly agentDir: string;

  constructor(agentDir: string) {
    this.agentDir = path.resolve(agentDir);
  }

  get dotAdkDir(): string {
    return path.join(this.agentDir, DOT_ADK_DIR_NAME);
  }

  get artifactsDir(): string {
    return path.join(this.dotAdkDir, ARTIFACTS_DIR_NAME);
  }

  get sessionDbPath(): string {
    return path.join(this.dotAdkDir, SESSION_DB_FILE_NAME);
  }
}

/** Returns true when `appName` names one directory entry and nothing else. */
function isSinglePathSegment(appName: string): boolean {
  return (
    appName !== '' &&
    appName !== '.' &&
    appName !== '..' &&
    // Both separators on every platform: `path.sep` is `/` on POSIX, and a
    // backslash still splits a path on Windows.
    !appName.includes('/') &&
    !appName.includes('\\')
  );
}

/**
 * Resolves `<agentsRoot>/<appName>`.
 *
 * `appName` reaches this function from an HTTP path parameter, so it is
 * untrusted input. The check is lexical, on resolved paths: it does not survive
 * symlinks, hardlinks, bind mounts or TOCTOU races, and it is not a sandbox.
 *
 * Dots stay literal. An adk-js app name is one path segment, and an agent file
 * named `my.agent.ts` yields the app name `my.agent`.
 *
 * @throws Error if `appName` is empty, is `.` or `..`, contains a path
 *     separator, or resolves outside `agentsRoot`.
 */
export function resolveAgentDir(options: {
  agentsRoot: string;
  appName: string;
}): string {
  const {agentsRoot, appName} = options;
  const root = path.resolve(agentsRoot);
  const agentDir = path.resolve(root, appName);
  const rel = path.relative(root, agentDir);

  if (
    !isSinglePathSegment(appName) ||
    rel === '..' ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  ) {
    // The resolved path stays out of the message: it can reach an HTTP client.
    throw new Error(
      `Invalid app name '${appName}': resolves outside the agents directory`,
    );
  }

  return agentDir;
}

/** Creates a `DotAdkFolder` for one agent rooted under `agentsRoot`. */
export function dotAdkFolderForAgent(options: {
  agentsRoot: string;
  appName: string;
}): DotAdkFolder {
  return new DotAdkFolder(resolveAgentDir(options));
}
