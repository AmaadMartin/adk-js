/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {exec, spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {getResponse, sendInput} from '../test_case_utils.js';

const execAsync = promisify(exec);
const dirname = process.cwd();

// `tests/integration/global_setup.ts` installs the fixture; the hook below only
// builds it. Each test then runs a short command inside the built fixture.
// Per-test budget, not a build budget: don't raise it for hook flakes, because
// the hooks are on the project's hookTimeout. It replaces the project's 60s
// testTimeout, because Windows CI is slow enough to need the wide margin.
const TEST_EXECUTION_TIMEOUT = 120000;

describe('Build setup', () => {
  describe.each([
    'js_commonjs',
    'js_esm',
    'ts_commonjs',
    'ts_esm',
    'ts_commonjs_native_addon',
    'ts_esm_native_addon',
  ])('%s', (buildSetup: string) => {
    const projectPath = `${dirname}/tests/integration/build_setup/${buildSetup}`;

    beforeAll(async () => {
      if (buildSetup.startsWith('ts_')) {
        let buildResult;
        try {
          buildResult = await execAsync('npm run build', {
            cwd: projectPath,
          });
        } catch (error: unknown) {
          console.error(`Build failed for ${buildSetup}:`);
          console.error(`stdout:\n${(error as {stdout: string}).stdout}`);
          console.error(`stderr:\n${(error as {stderr: string}).stderr}`);
          throw error;
        }
        expect(buildResult.stderr).toBe('');
        expect(buildResult.stdout).toContain('\nBuild complete');
      }
      // Replaces the project's 120s hookTimeout rather than raising it: the
      // fixture build is slow on Windows CI.
    }, 300000);

    it(
      'should build and run agent successfully',
      async () => {
        const childProcess = spawn('npm', ['run', 'start'], {
          cwd: projectPath,
          shell: true,
        });

        let response = await sendInput(childProcess, 'Tell me a joke.\n');
        expect(response.toString()).toContain('test-llm-model-response');

        response = await sendInput(childProcess, 'exit\n');
        expect(response.toString()).toContain('');
      },
      TEST_EXECUTION_TIMEOUT,
    );

    it.skipIf(
      !['js_commonjs', 'js_esm', 'ts_commonjs', 'ts_esm'].includes(buildSetup),
    )(
      'should handle dynamic imports in DatabaseSessionService',
      async () => {
        const childProcess = spawn('npm', ['run', 'test:db'], {
          cwd: projectPath,
          shell: true,
        });

        const response = await getResponse(childProcess);
        expect(response.toString()).toContain('DYNAMIC_IMPORT_SUCCESS');
      },
      TEST_EXECUTION_TIMEOUT,
    );

    it.skipIf(
      !['js_commonjs', 'js_esm', 'ts_commonjs', 'ts_esm'].includes(buildSetup),
    )(
      'should import devtools successfully',
      async () => {
        const childProcess = spawn('npm', ['run', 'test:devtools'], {
          cwd: projectPath,
          shell: true,
        });

        const response = await getResponse(childProcess);
        expect(response.toString()).toContain(
          'Devtools verification successful',
        );
      },
      TEST_EXECUTION_TIMEOUT,
    );

    it(
      'should run devtools CLI successfully',
      async () => {
        const {stdout} = await execAsync('npx @google/adk-devtools --version', {
          cwd: projectPath,
        });

        expect(stdout).toBeTruthy();
      },
      TEST_EXECUTION_TIMEOUT,
    );

    afterAll(async () => {
      // Only what the hook built. `global_setup.ts` removes `node_modules` and
      // `package-lock.json` for every fixture once the pool has stopped.
      const targets: string[] = [];
      if (buildSetup.startsWith('ts_')) {
        targets.push('dist');
      }

      // One target that cannot be removed must not stop the others, and must
      // not turn a passing suite red. It does change the next run's build
      // though, so report it.
      for (const target of targets) {
        await fs
          .rm(`${projectPath}/${target}`, {recursive: true, force: true})
          .catch((error: unknown) => {
            console.error(
              `Teardown failed for ${buildSetup} at ${target}:`,
              error,
            );
          });
      }
      // No hook budget: the 120s project hookTimeout already applies.
    });
  });
});
