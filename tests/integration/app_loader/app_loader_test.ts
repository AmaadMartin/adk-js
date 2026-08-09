/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, isApp, isBaseAgent} from '@google/adk';
import {exec, spawn} from 'node:child_process';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {AgentLoader} from '../../../dev/src/utils/agent_loader.js';
import {
  cleanUpFixture,
  removeInstallArtifacts,
  sendInput,
} from '../test_case_utils.js';

const execAsync = promisify(exec);
const dirname = process.cwd();

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
        // A run killed mid-install leaves a partial node_modules that
        // `npm install` does not clear, coupling this run to the last one.
        await removeInstallArtifacts(projectPath);
        await execAsync('npm install', {cwd: projectPath});
      });

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

      afterAll(() => cleanUpFixture(projectPath));
    },
  );
});

describe('AgentLoader discovery and loading integration', () => {
  const projectPath = path.join(
    dirname,
    'tests/integration/app_loader/discovery',
  );
  // Constructed eagerly so a failed install cannot leave `afterAll` with an
  // undefined `loader`; the constructor touches no filesystem.
  const loader = new AgentLoader(projectPath);

  beforeAll(async () => {
    await removeInstallArtifacts(projectPath);
    await execAsync('npm install', {cwd: projectPath});
  });

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
  });
});
