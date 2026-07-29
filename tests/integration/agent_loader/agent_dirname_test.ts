/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {exec, spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {sendInput} from '../test_case_utils.js';

const execAsync = promisify(exec);
const dirname = process.cwd();

// Hooks run a fixture npm install and the recursive node_modules teardown,
// which is slow on Windows and macOS.
const INSTALL_TIMEOUT = 180_000;

// Each test body spawns `npm run start`, which esbuild-bundles and minifies the
// whole @google/adk graph before the agent answers.
const TEST_EXECUTION_TIMEOUT = 120_000;

// Fixture deps are file: links to core/dev whose transitive deps are already in
// ~/.npm from the job-level install, so --prefer-offline resolves from cache
// instead of revalidating against the registry; --no-audit and --no-fund drop
// two more registry round trips.
const NPM_INSTALL = 'npm install --prefer-offline --no-audit --no-fund';

describe.each(['__dirname', '__filename', 'import_meta_url'])(
  'Agent with %s',
  (testCaseName: string) => {
    const projectPath = path.join(
      dirname,
      'tests/integration/agent_loader',
      testCaseName,
    );

    beforeAll(async () => {
      await execAsync(NPM_INSTALL, {cwd: projectPath});
    }, INSTALL_TIMEOUT);

    it(
      'should run agent and load params from file nearby via package.json script',
      async () => {
        const childProcess = spawn('npm', ['run', 'start'], {
          cwd: projectPath,
          shell: true,
        });

        let response = await sendInput(childProcess, 'Tell me a joke.\n');

        expect(response.toString()).toContain("I'm stubby model response!");

        response = await sendInput(childProcess, 'exit\n');
        expect(response.toString()).toContain('');
      },
      TEST_EXECUTION_TIMEOUT,
    );

    afterAll(async () => {
      await fs
        .rm(path.join(projectPath, 'node_modules'), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
      await fs
        .unlink(path.join(projectPath, 'package-lock.json'))
        .catch(() => {});
    }, INSTALL_TIMEOUT);
  },
);
