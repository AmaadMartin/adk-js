/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {access} from 'node:fs/promises';
import * as path from 'node:path';

/**
 * The built dev-workspace CLI, relative to the repository root.
 *
 * Fixtures under `tests/integration` invoke this file directly from their
 * `start` script, so they need no `node_modules` of their own. `npm install`
 * cannot link `node_modules/.bin/adk` for them: npm skips a workspace bin whose
 * target does not exist yet, and the repository builds only after installing.
 */
const DEV_CLI_PATH = path.join('dev', 'dist', 'esm', 'cli_entrypoint.js');

/**
 * Fails fast when the workspace-root build those fixtures rely on is missing.
 *
 * Without it the spawned `npm run start` dies before writing anything to
 * stdout, and the suite reports an empty-response assertion failure that says
 * nothing about the cause.
 */
export async function assertWorkspaceAdkCliAvailable(
  workspaceRoot = process.cwd(),
): Promise<void> {
  const cliPath = path.join(workspaceRoot, DEV_CLI_PATH);

  try {
    await access(cliPath);
  } catch (e: unknown) {
    throw new Error(
      `Missing ${cliPath}. Run \`npm install && npm run build\` at the repository root first.`,
      {cause: e},
    );
  }
}
