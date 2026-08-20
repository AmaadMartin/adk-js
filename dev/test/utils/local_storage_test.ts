/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  PerAgentDatabaseSessionService,
  PerAgentFileArtifactService,
  createLocalArtifactService,
  createLocalDatabaseSessionService,
} from '../../src/utils/local_storage.js';

const USER_ID = 'user_1';
const ARTIFACT = {text: 'hello artifact'};

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);

    return true;
  } catch (_e: unknown) {
    return false;
  }
}

/**
 * Removes the temporary tree, tolerating a file the process still holds open.
 *
 * `DatabaseSessionService` exposes no `close()`, so its SQLite handle stays
 * open for the life of the test process. Windows refuses to unlink an open
 * file, and a cleanup failure must not fail a test that already passed. The
 * operating system reclaims the temporary directory.
 */
async function removeTempTree(root: string): Promise<void> {
  try {
    await fs.rm(root, {recursive: true, force: true});
  } catch (_e: unknown) {
    return;
  }
}

describe('local storage', () => {
  let agentsRoot: string;

  beforeEach(async () => {
    agentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_local_storage-'));
  });

  afterEach(async () => {
    // A test that drops the write bit still has to leave a removable tree.
    await fs.chmod(agentsRoot, 0o700);
    await removeTempTree(agentsRoot);
  });

  describe('createLocalDatabaseSessionService', () => {
    it('creates the .adk folder and a usable session store', async () => {
      const baseDir = path.join(agentsRoot, 'weather_agent');
      const service = await createLocalDatabaseSessionService(baseDir);
      const session = await service.createSession({
        appName: 'weather_agent',
        userId: USER_ID,
      });

      expect(await exists(path.join(baseDir, '.adk', 'session.db'))).toBe(true);
      expect(session.appName).toBe('weather_agent');
    });
  });

  describe('createLocalArtifactService', () => {
    it('creates the artifacts folder and a usable artifact store', async () => {
      const baseDir = path.join(agentsRoot, 'weather_agent');
      const service = await createLocalArtifactService(baseDir);
      await service.saveArtifact({
        appName: 'weather_agent',
        userId: USER_ID,
        sessionId: 'session_1',
        filename: 'note.txt',
        artifact: ARTIFACT,
      });

      expect(await exists(path.join(baseDir, '.adk', 'artifacts'))).toBe(true);
    });
  });

  describe('PerAgentDatabaseSessionService', () => {
    it('gives every app its own session.db and hides the other app', async () => {
      const service = new PerAgentDatabaseSessionService({agentsRoot});
      await service.createSession({appName: 'weather_agent', userId: USER_ID});
      await service.createSession({appName: 'search_agent', userId: USER_ID});

      for (const appName of ['weather_agent', 'search_agent']) {
        expect(
          await exists(path.join(agentsRoot, appName, '.adk', 'session.db')),
        ).toBe(true);
        const listed = await service.listSessions({appName, userId: USER_ID});
        expect(listed.sessions).toHaveLength(1);
        expect(listed.sessions[0].appName).toBe(appName);
      }
    });

    it('keeps the session and its events across service instances', async () => {
      const first = new PerAgentDatabaseSessionService({agentsRoot});
      const session = await first.createSession({
        appName: 'weather_agent',
        userId: USER_ID,
      });
      await first.appendEvent({
        session,
        event: createEvent({author: 'user', invocationId: 'inv_1'}),
      });

      const second = new PerAgentDatabaseSessionService({agentsRoot});
      const reloaded = await second.getSession({
        appName: 'weather_agent',
        userId: USER_ID,
        sessionId: session.id,
      });

      expect(reloaded?.appName).toBe('weather_agent');
      expect(reloaded?.events).toHaveLength(1);
      expect(reloaded?.events[0].invocationId).toBe('inv_1');
    });

    it('deletes a session from that app store only', async () => {
      const service = new PerAgentDatabaseSessionService({agentsRoot});
      const session = await service.createSession({
        appName: 'weather_agent',
        userId: USER_ID,
      });
      await service.createSession({appName: 'search_agent', userId: USER_ID});

      await service.deleteSession({
        appName: 'weather_agent',
        userId: USER_ID,
        sessionId: session.id,
      });

      const weather = await service.listSessions({
        appName: 'weather_agent',
        userId: USER_ID,
      });
      const search = await service.listSessions({
        appName: 'search_agent',
        userId: USER_ID,
      });
      expect(weather.sessions).toHaveLength(0);
      expect(search.sessions).toHaveLength(1);
    });

    // A second store over one session.db re-runs the schema creation and
    // fails, so this passes only while concurrent callers share one store.
    it('builds one store for concurrent calls against one app', async () => {
      const service = new PerAgentDatabaseSessionService({agentsRoot});

      const listings = await Promise.all(
        Array.from({length: 5}, () =>
          service.listSessions({appName: 'weather_agent', userId: USER_ID}),
        ),
      );

      expect(listings.map((listing) => listing.sessions)).toEqual([
        [],
        [],
        [],
        [],
        [],
      ]);
    });

    it('builds one store per app for concurrent calls across apps', async () => {
      const service = new PerAgentDatabaseSessionService({agentsRoot});
      const appNames = ['weather_agent', 'search_agent', 'travel_agent'];

      const sessions = await Promise.all(
        appNames.map((appName) =>
          service.createSession({appName, userId: USER_ID}),
        ),
      );

      expect(sessions.map((session) => session.appName)).toEqual(appNames);
      for (const appName of appNames) {
        expect(
          await exists(path.join(agentsRoot, appName, '.adk', 'session.db')),
        ).toBe(true);
      }
    });

    it('rejects an app name that escapes the agents root', async () => {
      const service = new PerAgentDatabaseSessionService({agentsRoot});

      await expect(
        service.createSession({appName: '../evil', userId: USER_ID}),
      ).rejects.toThrow(/Invalid app name/);
      expect(await exists(path.join(path.dirname(agentsRoot), 'evil'))).toBe(
        false,
      );
    });

    // POSIX only: a Windows directory stays writable after `chmod`.
    it.skipIf(process.platform === 'win32')(
      'reports a permission failure instead of losing the data',
      async () => {
        await fs.chmod(agentsRoot, 0o500);
        const service = new PerAgentDatabaseSessionService({agentsRoot});

        await expect(
          service.createSession({appName: 'weather_agent', userId: USER_ID}),
        ).rejects.toThrow(/EACCES/);
        expect(await exists(path.join(agentsRoot, 'weather_agent'))).toBe(
          false,
        );
      },
    );

    it('reports a disk failure instead of losing the data', async () => {
      // A file sits where the agent directory belongs, so `mkdir` fails.
      await fs.writeFile(path.join(agentsRoot, 'weather_agent'), 'not a dir');
      const service = new PerAgentDatabaseSessionService({agentsRoot});

      await expect(
        service.createSession({appName: 'weather_agent', userId: USER_ID}),
      ).rejects.toThrow(/weather_agent/);
    });
  });

  describe('PerAgentFileArtifactService', () => {
    it('gives every app its own artifacts folder and hides the other app', async () => {
      const service = new PerAgentFileArtifactService({agentsRoot});
      await service.saveArtifact({
        appName: 'weather_agent',
        userId: USER_ID,
        sessionId: 'session_1',
        filename: 'note.txt',
        artifact: ARTIFACT,
      });

      const otherApp = await service.listArtifactKeys({
        appName: 'search_agent',
        userId: USER_ID,
        sessionId: 'session_1',
      });

      expect(
        await exists(
          path.join(agentsRoot, 'weather_agent', '.adk', 'artifacts'),
        ),
      ).toBe(true);
      expect(otherApp).toEqual([]);
    });

    it('delegates every artifact operation to the app store', async () => {
      const service = new PerAgentFileArtifactService({agentsRoot});
      const key = {
        appName: 'weather_agent',
        userId: USER_ID,
        sessionId: 'session_1',
      };

      const version = await service.saveArtifact({
        ...key,
        filename: 'note.txt',
        artifact: ARTIFACT,
        customMetadata: {origin: 'test'},
      });
      expect(version).toBe(0);

      const loaded = await service.loadArtifact({...key, filename: 'note.txt'});
      expect(loaded?.text).toBe(ARTIFACT.text);
      expect(await service.listArtifactKeys(key)).toEqual(['note.txt']);
      expect(
        await service.listVersions({...key, filename: 'note.txt'}),
      ).toEqual([0]);

      const versions = await service.listArtifactVersions({
        ...key,
        filename: 'note.txt',
      });
      expect(versions).toHaveLength(1);
      expect(versions[0].customMetadata).toEqual({origin: 'test'});

      const single = await service.getArtifactVersion({
        ...key,
        filename: 'note.txt',
        version: 0,
      });
      expect(single?.version).toBe(0);

      await service.deleteArtifact({...key, filename: 'note.txt'});
      expect(await service.listArtifactKeys(key)).toEqual([]);
    });

    it('rejects an app name that escapes the agents root', async () => {
      const service = new PerAgentFileArtifactService({agentsRoot});

      await expect(
        service.listArtifactKeys({
          appName: '../evil',
          userId: USER_ID,
          sessionId: 'session_1',
        }),
      ).rejects.toThrow(/Invalid app name/);
      expect(await exists(path.join(path.dirname(agentsRoot), 'evil'))).toBe(
        false,
      );
    });
  });
});
