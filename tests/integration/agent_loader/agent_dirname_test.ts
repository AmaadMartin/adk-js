/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import * as path from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {sendInput} from '../test_case_utils.js';
import {assertWorkspaceAdkCliAvailable} from '../workspace_cli.js';

const dirname = process.cwd();

// Each test body spawns `npm run start`, which esbuild-bundles and minifies the
// whole @google/adk graph before the agent answers. This replaces the project's
// 60s testTimeout rather than raising it, and it states the same budget
// `build_setup_test.ts` states for that same `npm run start` work.
const TEST_EXECUTION_TIMEOUT = 120_000;

describe.each(['__dirname', '__filename', 'import_meta_url', 'dependency_url'])(
  'Agent with %s',
  (testCaseName: string) => {
    const projectPath = path.join(
      dirname,
      'tests/integration/agent_loader',
      testCaseName,
    );

    // The fixture no longer installs: `tests/integration/global_setup.ts`
    // does that, and the `start` script runs the CLI built at the workspace
    // root, so the only precondition left is that build.
    beforeAll(async () => {
      await assertWorkspaceAdkCliAvailable();
    });

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
  },
);
