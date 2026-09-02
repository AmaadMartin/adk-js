/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DatabaseSessionService, FileArtifactService} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  createLocalArtifactService,
  createLocalSessionService,
  resolveUseLocalStorage,
} from '../../src/cli/local_storage.js';

describe('local_storage', () => {
  let baseDir: string;
  const savedEnv = {...process.env};

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-local-storage-'));
    delete process.env['ADK_DISABLE_LOCAL_STORAGE'];
    delete process.env['ADK_FORCE_LOCAL_STORAGE'];
  });

  afterEach(async () => {
    process.env = {...savedEnv};
    await fs.chmod(baseDir, 0o700).catch(() => {});
    await fs.rm(baseDir, {recursive: true, force: true});
  });

  describe('resolveUseLocalStorage', () => {
    it('honours a request for a writable directory', async () => {
      expect(await resolveUseLocalStorage(baseDir, true)).toEqual({
        useLocalStorage: true,
      });
    });

    it('honours a request to stay in memory', async () => {
      expect(await resolveUseLocalStorage(baseDir, false)).toEqual({
        useLocalStorage: false,
      });
    });

    it('refuses when ADK_DISABLE_LOCAL_STORAGE is on', async () => {
      process.env['ADK_DISABLE_LOCAL_STORAGE'] = '1';

      const decision = await resolveUseLocalStorage(baseDir, true);

      expect(decision.useLocalStorage).toBe(false);
      expect(decision.warning).toContain('ADK_DISABLE_LOCAL_STORAGE');
    });

    it('forces local storage when ADK_FORCE_LOCAL_STORAGE is on', async () => {
      process.env['ADK_FORCE_LOCAL_STORAGE'] = 'true';

      expect(await resolveUseLocalStorage(baseDir, false)).toEqual({
        useLocalStorage: true,
      });
    });

    it('refuses a forced directory it cannot write to', async () => {
      process.env['ADK_FORCE_LOCAL_STORAGE'] = '1';
      await fs.chmod(baseDir, 0o500);

      const decision = await resolveUseLocalStorage(baseDir, false);

      expect(decision.useLocalStorage).toBe(false);
      expect(decision.warning).toContain('is not writable');
    });

    it('falls back to memory for a directory it cannot write to', async () => {
      await fs.chmod(baseDir, 0o500);

      const decision = await resolveUseLocalStorage(baseDir, true);

      expect(decision.useLocalStorage).toBe(false);
      expect(decision.warning).toContain('ADK_FORCE_LOCAL_STORAGE=1');
    });

    it('falls back to memory for a directory that does not exist', async () => {
      const decision = await resolveUseLocalStorage(
        path.join(baseDir, 'missing'),
        true,
      );

      expect(decision.useLocalStorage).toBe(false);
    });

    it('falls back to memory when the path is a file', async () => {
      const filePath = path.join(baseDir, 'agent.ts');
      await fs.writeFile(filePath, '');

      const decision = await resolveUseLocalStorage(filePath, true);

      expect(decision.useLocalStorage).toBe(false);
    });
  });

  it('roots the session database in the .adk folder', async () => {
    const service = await createLocalSessionService(baseDir);

    expect(service).toBeInstanceOf(DatabaseSessionService);
    await expect(fs.stat(path.join(baseDir, '.adk'))).resolves.toBeDefined();
  });

  it('roots the artifacts in the .adk folder', async () => {
    const service = await createLocalArtifactService(baseDir);

    expect(service).toBeInstanceOf(FileArtifactService);
    await expect(fs.stat(path.join(baseDir, '.adk'))).resolves.toBeDefined();
  });
});
