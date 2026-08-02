/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, isApp, isBaseAgent} from '@google/adk';
import {exec, spawn} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {AgentLoader} from '../../../dev/src/utils/agent_loader.js';
import {sendInput} from '../test_case_utils.js';

const execAsync = promisify(exec);
const dirname = process.cwd();

// Budget (ms) for the install hooks below. They run `npm install` in a fixture
// project, which resolves the full transitive tree for `@google/adk` and
// `@google/adk-devtools`; a cold, network-bound install runs well past 40s on a
// loaded runner, and when the hook is killed mid-install it leaves a partial
// `node_modules` that changes the next run's cost. Matches HOOK_TIMEOUT in
// build_setup_test.ts and INTEGRATION_HOOK_TIMEOUT_MS in vitest.config.ts.
// Trade-off: a genuinely stuck install now takes this long to surface.
// The per-test budget is intentionally not set in this file - the `integration`
// project in vitest.config.ts supplies it (INTEGRATION_TEST_TIMEOUT_MS).
const HOOK_TIMEOUT = 120000;

/**
 * Deletes everything `npm install` writes into a fixture project.
 *
 * `force: true` makes a missing path a no-op, so anything that still rejects
 * here is a real failure (EACCES, EPERM, EBUSY) rather than "already gone".
 */
async function removeInstallArtifacts(projectPath: string): Promise<void> {
  // `maxRetries`/`retryDelay` absorb the transient unlink races that recursive
  // `node_modules` removal hits on Windows. Node ignores both unless
  // `recursive` is set, so the lockfile removal below does not pass them.
  await fs.rm(path.join(projectPath, 'node_modules'), {
    force: true,
    recursive: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  await fs.rm(path.join(projectPath, 'package-lock.json'), {force: true});
}

/**
 * Teardown variant of {@link removeInstallArtifacts}. Every `beforeAll` below
 * re-cleans before installing, so determinism no longer depends on teardown
 * succeeding: a failure here must not fail an otherwise green suite, but it
 * must still be visible.
 */
async function cleanUpFixture(projectPath: string): Promise<void> {
  try {
    await removeInstallArtifacts(projectPath);
  } catch (error) {
    console.warn(`Failed to clean up fixture at ${projectPath}:`, error);
  }
}

describe('App loader CLI integration', () => {
  describe.each(['app_ts', 'app_js', 'app_default'])(
    'App entrypoint with %s',
    (testCaseName: string) => {
      const projectPath = path.join(
        dirname,
        'tests/integration/app_loader',
        testCaseName,
      );

      beforeAll(async () => {
        // A run killed mid-install leaves a partial node_modules behind, and
        // installing on top of it is what made this suite fail on alternate
        // runs.
        await removeInstallArtifacts(projectPath);
        await execAsync('npm install', {cwd: projectPath});
      }, HOOK_TIMEOUT);

      it('should run app via package.json start script and get responses', async () => {
        const childProcess = spawn('npm', ['run', 'start'], {
          cwd: projectPath,
          shell: true,
        });

        let response = await sendInput(
          childProcess,
          'Tell me about the app.\n',
        );

        expect(response.toString()).toContain('Hello from');

        response = await sendInput(childProcess, 'exit\n');
        expect(response.toString()).toContain('');
      });

      afterAll(() => cleanUpFixture(projectPath), HOOK_TIMEOUT);
    },
  );
});

describe('AgentLoader discovery and loading integration', () => {
  const projectPath = path.join(
    dirname,
    'tests/integration/app_loader/discovery',
  );
  // Constructed here rather than in `beforeAll`: the constructor only records
  // the directory and registers exit handlers, so it cannot fail, and an
  // install failure can no longer leave `afterAll` with an undefined `loader`.
  const loader = new AgentLoader(projectPath);

  beforeAll(async () => {
    await removeInstallArtifacts(projectPath);
    await execAsync('npm install', {cwd: projectPath});
  }, HOOK_TIMEOUT);

  it('should discover apps vs agents across directories and standalone files', async () => {
    const apps = await loader.listApps();
    expect(apps).toHaveLength(2);
    expect(apps).toContain('service_alpha');
    expect(apps).toContain('standalone_app');

    const agentsAndApps = await loader.listAgents();
    expect(agentsAndApps).toHaveLength(4);
    expect(agentsAndApps).toContain('service_alpha');
    expect(agentsAndApps).toContain('service_beta');
    expect(agentsAndApps).toContain('standalone_agent');
    expect(agentsAndApps).toContain('standalone_app');
  });

  it('should load App from directory entrypoint and expose App and rootAgent', async () => {
    const appFile = await loader.getAppFile('service_alpha');
    const loaded = await appFile.load();
    expect(isApp(loaded)).toBe(true);
    expect((loaded as App).name).toBe('alpha_app');

    const rootAgent = await appFile.loadAgent();
    expect(isBaseAgent(rootAgent)).toBe(true);
    expect(rootAgent.name).toBe('alpha_agent');
  });

  it('should synthesize App when loadApp() is called on BaseAgent file', async () => {
    const agentFile = await loader.getAppFile('service_beta');
    const loaded = await agentFile.load();
    expect(isBaseAgent(loaded)).toBe(true);
    expect(isApp(loaded)).toBe(false);

    const synthApp = await agentFile.loadApp();
    expect(isApp(synthApp)).toBe(true);
    expect(synthApp.rootAgent.name).toBe('beta_agent');
  });

  afterAll(async () => {
    // `finally` so a disposeAll() failure cannot skip the fixture cleanup.
    try {
      await loader.disposeAll();
    } finally {
      await cleanUpFixture(projectPath);
    }
  }, HOOK_TIMEOUT);
});
