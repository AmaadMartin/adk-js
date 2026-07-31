/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {exec, spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  cleanupFixtureDeps,
  getResponse,
  installFixtureDeps,
  sendInput,
} from '../test_case_utils.js';

const execAsync = promisify(exec);
const dirname = process.cwd();

const TEST_EXECUTION_TIMEOUT = 20000;

/** The subset of a fixture lockfile this suite asserts on. */
interface FixtureLockfile {
  packages: Record<string, {link?: boolean}>;
}

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
      await installFixtureDeps(projectPath);

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
    });

    it('should link the workspace packages rather than pack them', async () => {
      const lock: FixtureLockfile = JSON.parse(
        await fs.readFile(`${projectPath}/package-lock.json`, 'utf-8'),
      );

      // Asserted on the lockfile rather than `lstat().isSymbolicLink()`: npm
      // creates junctions on Windows, but records `link: true` on every npm
      // major and every OS in the matrix. Packing the workspaces instead drops
      // the flag and grows this lockfile from 5 entries to ~630.
      expect(lock.packages['node_modules/@google/adk']?.link).toBe(true);
      expect(lock.packages['node_modules/@google/adk-devtools']?.link).toBe(
        true,
      );
    });

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
      await cleanupFixtureDeps(projectPath);

      if (buildSetup.startsWith('ts_')) {
        await fs.rm(`${projectPath}/dist`, {recursive: true, force: true});
      }
    });
  });
});
