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
const TEST_EXECUTION_TIMEOUT = 40000;

describe.each(['__dirname', '__filename', 'import_meta_url'])(
  'Agent with %s',
  (testCaseName: string) => {
    const projectPath = path.join(
      dirname,
      'tests/integration/agent_loader',
      testCaseName,
    );

    beforeAll(async () => {
      await execAsync('npm install', {cwd: projectPath});
    }, TEST_EXECUTION_TIMEOUT);

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
      // Reported, not thrown: a dirty fixture must be visible, but a failed
      // teardown must not turn a green suite red. Each removal is independent
      // so an early failure cannot skip the rest.
      for (const target of ['node_modules', 'package-lock.json']) {
        await fs
          .rm(path.join(projectPath, target), {recursive: true, force: true})
          .catch((error: unknown) =>
            console.error(
              `Cleanup failed for ${projectPath}/${target}:`,
              error,
            ),
          );
      }
    }, TEST_EXECUTION_TIMEOUT);
  },
);
