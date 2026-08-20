/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryArtifactService, InMemorySessionService} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  PerAgentDatabaseSessionService,
  PerAgentFileArtifactService,
} from '../../src/utils/local_storage.js';
import {
  createArtifactServiceFromOptions,
  createSessionServiceFromOptions,
  isDirWritable,
  isEnvFlagEnabled,
  resolveAgentsRoot,
  resolveUseLocalStorage,
} from '../../src/utils/service_factory.js';

const MANAGED_ENV_VARS = [
  'ADK_FORCE_LOCAL_STORAGE',
  'K_SERVICE',
  'KUBERNETES_SERVICE_HOST',
  'TEST_ADK_FLAG',
];

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);

    return true;
  } catch (_e: unknown) {
    return false;
  }
}

describe('service factory', () => {
  let agentsRoot: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    agentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_factory-'));
    savedEnv = Object.fromEntries(
      MANAGED_ENV_VARS.map((name) => [name, process.env[name]]),
    );
    for (const name of MANAGED_ENV_VARS) {
      delete process.env[name];
    }
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await fs.chmod(agentsRoot, 0o700);
    await fs.rm(agentsRoot, {recursive: true, force: true});
  });

  describe('isEnvFlagEnabled', () => {
    it.each(['1', 'true', 'TRUE'])('reads %s as enabled', (value) => {
      process.env['TEST_ADK_FLAG'] = value;

      expect(isEnvFlagEnabled('TEST_ADK_FLAG')).toBe(true);
    });

    it.each(['0', 'false', 'yes', ''])('reads %s as disabled', (value) => {
      process.env['TEST_ADK_FLAG'] = value;

      expect(isEnvFlagEnabled('TEST_ADK_FLAG')).toBe(false);
    });

    it('reads an unset variable as disabled', () => {
      expect(isEnvFlagEnabled('TEST_ADK_FLAG')).toBe(false);
    });
  });

  describe('isDirWritable', () => {
    it('accepts a writable directory', async () => {
      expect(await isDirWritable(agentsRoot)).toBe(true);
    });

    it('rejects a path that does not exist', async () => {
      expect(await isDirWritable(path.join(agentsRoot, 'missing'))).toBe(false);
    });

    it('rejects a file', async () => {
      const file = path.join(agentsRoot, 'agent.ts');
      await fs.writeFile(file, '');

      expect(await isDirWritable(file)).toBe(false);
    });

    // POSIX only: a Windows directory stays writable after `chmod`.
    it.skipIf(process.platform === 'win32')(
      'rejects a directory it cannot write',
      async () => {
        await fs.chmod(agentsRoot, 0o500);

        expect(await isDirWritable(agentsRoot)).toBe(false);
      },
    );
  });

  describe('resolveUseLocalStorage', () => {
    it('uses local storage for a writable directory', async () => {
      expect(
        await resolveUseLocalStorage({baseDir: agentsRoot, requested: true}),
      ).toEqual({useLocalStorage: true});
    });

    it.each(['K_SERVICE', 'KUBERNETES_SERVICE_HOST'])(
      'refuses local storage when %s is set',
      async (name) => {
        process.env[name] = 'some-value';

        const decision = await resolveUseLocalStorage({
          baseDir: agentsRoot,
          requested: true,
        });

        expect(decision.useLocalStorage).toBe(false);
        expect(decision.warning).toContain('ADK_FORCE_LOCAL_STORAGE');
      },
    );

    // The force branch sits above the container check on purpose.
    it('lets ADK_FORCE_LOCAL_STORAGE beat a detected container', async () => {
      process.env['ADK_FORCE_LOCAL_STORAGE'] = '1';
      process.env['K_SERVICE'] = 'some-service';

      expect(
        await resolveUseLocalStorage({baseDir: agentsRoot, requested: true}),
      ).toEqual({useLocalStorage: true});
    });

    it('refuses a forced run against a directory that does not exist', async () => {
      process.env['ADK_FORCE_LOCAL_STORAGE'] = '1';

      const decision = await resolveUseLocalStorage({
        baseDir: path.join(agentsRoot, 'missing'),
        requested: true,
      });

      expect(decision.useLocalStorage).toBe(false);
      expect(decision.warning).toContain('ADK_FORCE_LOCAL_STORAGE');
    });

    it('refuses without a warning when the caller asked for memory', async () => {
      expect(
        await resolveUseLocalStorage({baseDir: agentsRoot, requested: false}),
      ).toEqual({useLocalStorage: false});
    });

    it('refuses a directory that does not exist', async () => {
      const decision = await resolveUseLocalStorage({
        baseDir: path.join(agentsRoot, 'missing'),
        requested: true,
      });

      expect(decision.useLocalStorage).toBe(false);
      expect(decision.warning).toContain('not writable');
    });
  });

  describe('resolveAgentsRoot', () => {
    it('returns a directory unchanged', async () => {
      expect(await resolveAgentsRoot(agentsRoot)).toBe(agentsRoot);
    });

    it('returns the parent of a single agent file', async () => {
      const file = path.join(agentsRoot, 'weather.ts');
      await fs.writeFile(file, '');

      expect(await resolveAgentsRoot(file)).toBe(agentsRoot);
    });
  });

  describe('createSessionServiceFromOptions', () => {
    it('routes per agent by default', async () => {
      const service = await createSessionServiceFromOptions({
        baseDir: agentsRoot,
      });

      expect(service).toBeInstanceOf(PerAgentDatabaseSessionService);
    });

    it('warns and serves from memory in a detected container', async () => {
      process.env['K_SERVICE'] = 'some-service';

      const service = await createSessionServiceFromOptions({
        baseDir: agentsRoot,
      });
      await service.createSession({appName: 'weather_agent', userId: 'u1'});

      expect(service).toBeInstanceOf(InMemorySessionService);
      expect(await exists(path.join(agentsRoot, 'weather_agent'))).toBe(false);
    });

    it('uses the URI service and creates no .adk folder', async () => {
      const service = await createSessionServiceFromOptions({
        baseDir: agentsRoot,
        sessionServiceUri: 'memory://',
      });
      await service.createSession({appName: 'weather_agent', userId: 'u1'});

      expect(service).toBeInstanceOf(InMemorySessionService);
      expect(await exists(path.join(agentsRoot, 'weather_agent'))).toBe(false);
    });

    it('falls back to memory and creates no .adk folder when refused', async () => {
      const service = await createSessionServiceFromOptions({
        baseDir: agentsRoot,
        useLocalStorage: false,
      });
      await service.createSession({appName: 'weather_agent', userId: 'u1'});

      expect(service).toBeInstanceOf(InMemorySessionService);
      expect(await exists(path.join(agentsRoot, 'weather_agent'))).toBe(false);
    });
  });

  describe('createArtifactServiceFromOptions', () => {
    it('routes per agent by default', async () => {
      const service = await createArtifactServiceFromOptions({
        baseDir: agentsRoot,
      });

      expect(service).toBeInstanceOf(PerAgentFileArtifactService);
    });

    it('uses the URI service and creates no .adk folder', async () => {
      const service = await createArtifactServiceFromOptions({
        baseDir: agentsRoot,
        artifactServiceUri: 'memory://',
      });
      await service.saveArtifact({
        appName: 'weather_agent',
        userId: 'u1',
        sessionId: 's1',
        filename: 'note.txt',
        artifact: {text: 'hello'},
      });

      expect(service).toBeInstanceOf(InMemoryArtifactService);
      expect(await exists(path.join(agentsRoot, 'weather_agent'))).toBe(false);
    });

    it('falls back to memory and creates no .adk folder when refused', async () => {
      const service = await createArtifactServiceFromOptions({
        baseDir: agentsRoot,
        useLocalStorage: false,
      });
      await service.saveArtifact({
        appName: 'weather_agent',
        userId: 'u1',
        sessionId: 's1',
        filename: 'note.txt',
        artifact: {text: 'hello'},
      });

      expect(service).toBeInstanceOf(InMemoryArtifactService);
      expect(await exists(path.join(agentsRoot, 'weather_agent'))).toBe(false);
    });
  });
});
