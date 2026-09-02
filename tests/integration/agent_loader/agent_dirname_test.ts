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

    // No test budget: the 60s project testTimeout already bounds this.
    it('should run agent and load params from file nearby via package.json script', async () => {
      const childProcess = spawn('npm', ['run', 'start'], {
        cwd: projectPath,
        shell: true,
      });

      let response = await sendInput(childProcess, 'Tell me a joke.\n');

      expect(response.toString()).toContain("I'm stubby model response!");

      response = await sendInput(childProcess, 'exit\n');
      expect(response.toString()).toContain('');
    });
  },
);
