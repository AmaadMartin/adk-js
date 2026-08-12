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

// These hooks run `npm install` (plus `npm run build` for ts_* setups) and the
// recursive node_modules teardown, overrunning vitest's default 10s hookTimeout
// and causing flaky "Hook timed out in 10000ms" failures. All twelve hook runs
// take ~16s combined on ubuntu-latest, but a cold, network-bound install has
// been measured at ~70s, so 120s covers the worst case. Trade-off: a stuck hook
// now takes this long to surface.
const HOOK_TIMEOUT = 120000;

// No per-test timeout below: these take the project's 60s testTimeout. The
// slowest, `should build and run agent successfully`, takes 14.9s on
// windows-latest (measured 2026-08-11), which the old 20s budget could not hold
// under CI load. Trade-off: a hung child now takes 60s to surface.
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
      await execAsync('npm install', {cwd: projectPath});

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
    }, HOOK_TIMEOUT);

    it('should build and run agent successfully', async () => {
      const childProcess = spawn('npm', ['run', 'start'], {
        cwd: projectPath,
        shell: true,
      });

      let response = await sendInput(childProcess, 'Tell me a joke.\n');
      expect(response.toString()).toContain('test-llm-model-response');

      response = await sendInput(childProcess, 'exit\n');
      expect(response.toString()).toContain('');
    });

    it.skipIf(
      !['js_commonjs', 'js_esm', 'ts_commonjs', 'ts_esm'].includes(buildSetup),
    )('should handle dynamic imports in DatabaseSessionService', async () => {
      const childProcess = spawn('npm', ['run', 'test:db'], {
        cwd: projectPath,
        shell: true,
      });

      const response = await getResponse(childProcess);
      expect(response.toString()).toContain('DYNAMIC_IMPORT_SUCCESS');
    });

    it.skipIf(
      !['js_commonjs', 'js_esm', 'ts_commonjs', 'ts_esm'].includes(buildSetup),
    )('should import devtools successfully', async () => {
      const childProcess = spawn('npm', ['run', 'test:devtools'], {
        cwd: projectPath,
        shell: true,
      });

      const response = await getResponse(childProcess);
      expect(response.toString()).toContain('Devtools verification successful');
    });

    it('should run devtools CLI successfully', async () => {
      const {stdout} = await execAsync('npx @google/adk-devtools --version', {
        cwd: projectPath,
      });

      expect(stdout).toBeTruthy();
    });

    afterAll(async () => {
      await fs
        .rm(`${projectPath}/node_modules`, {recursive: true, force: true})
        .catch(() => {});
      await fs.unlink(`${projectPath}/package-lock.json`).catch(() => {});

      if (buildSetup.startsWith('ts_')) {
        await fs
          .rm(`${projectPath}/dist`, {recursive: true, force: true})
          .catch(() => {});
      }
    }, HOOK_TIMEOUT);
  });
});
