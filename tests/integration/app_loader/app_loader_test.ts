/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {App, isApp, isBaseAgent} from '@google/adk';
import {spawn} from 'node:child_process';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {AgentLoader} from '../../../dev/src/utils/agent_loader.js';
import {
  cleanupFixtureProject,
  FIXTURE_HOOK_TIMEOUT_MS,
  FIXTURE_RUN_TIMEOUT_MS,
  installFixtureProject,
} from '../fixture_project.js';
import {sendInput} from '../test_case_utils.js';

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
        await installFixtureProject(projectPath);
      }, FIXTURE_HOOK_TIMEOUT_MS);

      it(
        'should run app via package.json start script and get responses',
        async () => {
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
        },
        FIXTURE_RUN_TIMEOUT_MS,
      );

      afterAll(async () => {
        await cleanupFixtureProject(projectPath);
      }, FIXTURE_HOOK_TIMEOUT_MS);
    },
  );
});

describe('AgentLoader discovery and loading integration', () => {
  const projectPath = path.join(
    dirname,
    'tests/integration/app_loader/discovery',
  );
  let loader: AgentLoader;

  beforeAll(async () => {
    await installFixtureProject(projectPath);
    loader = new AgentLoader(projectPath);
  }, FIXTURE_HOOK_TIMEOUT_MS);

  it(
    'should discover apps vs agents across directories and standalone files',
    async () => {
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
    },
    FIXTURE_RUN_TIMEOUT_MS,
  );

  it(
    'should load App from directory entrypoint and expose App and rootAgent',
    async () => {
      const appFile = await loader.getAppFile('service_alpha');
      const loaded = await appFile.load();
      expect(isApp(loaded)).toBe(true);
      expect((loaded as App).name).toBe('alpha_app');

      const rootAgent = await appFile.loadAgent();
      expect(isBaseAgent(rootAgent)).toBe(true);
      expect(rootAgent.name).toBe('alpha_agent');
    },
    FIXTURE_RUN_TIMEOUT_MS,
  );

  it(
    'should synthesize App when loadApp() is called on BaseAgent file',
    async () => {
      const agentFile = await loader.getAppFile('service_beta');
      const loaded = await agentFile.load();
      expect(isBaseAgent(loaded)).toBe(true);
      expect(isApp(loaded)).toBe(false);

      const synthApp = await agentFile.loadApp();
      expect(isApp(synthApp)).toBe(true);
      expect(synthApp.rootAgent.name).toBe('beta_agent');
    },
    FIXTURE_RUN_TIMEOUT_MS,
  );

  afterAll(async () => {
    await loader.disposeAll();
    await cleanupFixtureProject(projectPath);
  }, FIXTURE_HOOK_TIMEOUT_MS);
});
