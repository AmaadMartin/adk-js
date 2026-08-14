/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {assertWorkspaceAdkCliAvailable} from './workspace_cli.js';

describe('assertWorkspaceAdkCliAvailable', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-cli-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, {recursive: true, force: true});
  });

  it('resolves when the dev CLI has been built', async () => {
    const cliDir = path.join(workspaceRoot, 'dev', 'dist', 'esm');
    await fs.mkdir(cliDir, {recursive: true});
    await fs.writeFile(path.join(cliDir, 'cli_entrypoint.js'), '');

    await expect(
      assertWorkspaceAdkCliAvailable(workspaceRoot),
    ).resolves.toBeUndefined();
  });

  it('rejects naming the missing CLI path when the workspace is not built', async () => {
    await expect(assertWorkspaceAdkCliAvailable(workspaceRoot)).rejects.toThrow(
      `Missing ${path.join(workspaceRoot, 'dev', 'dist', 'esm', 'cli_entrypoint.js')}. Run \`npm install && npm run build\` at the repository root first.`,
    );
  });
});
