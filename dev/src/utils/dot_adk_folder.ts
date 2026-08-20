/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

const DOT_ADK_DIR_NAME = '.adk';

/** Returns the `.adk` folder that holds one agent's persisted data. */
export function dotAdkDir(agentDir: string): string {
  return path.join(agentDir, DOT_ADK_DIR_NAME);
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
