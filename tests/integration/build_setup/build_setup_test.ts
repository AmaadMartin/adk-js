/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {exec, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  cleanupFixtureProject,
  FIXTURE_HOOK_TIMEOUT_MS,
  FIXTURE_RUN_TIMEOUT_MS,
  installFixtureProject,
} from '../fixture_project.js';
import {getResponse, sendInput} from '../test_case_utils.js';

const execAsync = promisify(exec);
const dirname = process.cwd();

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
      await installFixtureProject(projectPath);

      if (buildSetup.startsWith('ts_')) {
        const buildResult = await execAsync('npm run build', {
          cwd: projectPath,
        });
        expect(buildResult.stderr).toBe('');
        expect(buildResult.stdout).toContain('\nBuild complete');
      }
    }, FIXTURE_HOOK_TIMEOUT_MS);

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
      FIXTURE_RUN_TIMEOUT_MS,
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
      FIXTURE_RUN_TIMEOUT_MS,
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
      FIXTURE_RUN_TIMEOUT_MS,
    );

    it(
      'should run devtools CLI successfully',
      async () => {
        const {stdout} = await execAsync('npx @google/adk-devtools --version', {
          cwd: projectPath,
        });

        expect(stdout).toBeTruthy();
      },
      FIXTURE_RUN_TIMEOUT_MS,
    );

    afterAll(async () => {
      await cleanupFixtureProject(projectPath);
    }, FIXTURE_HOOK_TIMEOUT_MS);
  });
});
