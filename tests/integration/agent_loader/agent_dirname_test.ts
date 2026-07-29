/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  cleanupFixtureProject,
  FIXTURE_HOOK_TIMEOUT_MS,
  FIXTURE_RUN_TIMEOUT_MS,
  installFixtureProject,
} from '../fixture_project.js';
import {sendInput} from '../test_case_utils.js';

const dirname = process.cwd();

describe.each(['__dirname', '__filename', 'import_meta_url'])(
  'Agent with %s',
  (testCaseName: string) => {
    const projectPath = path.join(
      dirname,
      'tests/integration/agent_loader',
      testCaseName,
    );

    beforeAll(async () => {
      await installFixtureProject(projectPath);
    }, FIXTURE_HOOK_TIMEOUT_MS);

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
      FIXTURE_RUN_TIMEOUT_MS,
    );

    afterAll(async () => {
      await cleanupFixtureProject(projectPath);
    }, FIXTURE_HOOK_TIMEOUT_MS);
  },
);
