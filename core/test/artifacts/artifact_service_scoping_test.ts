/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseArtifactService,
  FileArtifactService,
  GcsArtifactService,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {fakeStorage} from './fake_gcs_storage.js';

vi.mock('@google-cloud/storage', async () => {
  const {fakeStorage: storage} = await import('./fake_gcs_storage.js');
  return {Storage: vi.fn(() => storage)};
});

const BUCKET_NAME = 'test-bucket';
const APP_NAME = 'app0';
const USER_ID = 'user0';
const SESSION_ID = '123';

interface ServiceLane {
  name: string;
  create(): Promise<BaseArtifactService>;
  cleanup(): Promise<void>;
}

const gcsLane: ServiceLane = {
  name: 'GcsArtifactService',
  async create() {
    fakeStorage.buckets.clear();
    return new GcsArtifactService(BUCKET_NAME);
  },
  async cleanup() {
    fakeStorage.buckets.clear();
  },
};

let fileRootDir: string | undefined;

const fileLane: ServiceLane = {
  name: 'FileArtifactService',
  async create() {
    fileRootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'adk-artifacts-scoping-'),
    );
    return new FileArtifactService(fileRootDir);
  },
  async cleanup() {
    if (fileRootDir) {
      await fs.rm(fileRootDir, {recursive: true, force: true});
      fileRootDir = undefined;
    }
  },
};

describe('artifact service keyspace scoping', () => {
  // A filename may contain "/", so "doc" and "doc/nested" are two artifacts.
  // Only the GCS service derives versions by scanning a key prefix, so only it
  // can read the nested artifact's blobs as versions of the parent. The
  // in-memory and file services key each artifact exactly.
  describe('GcsArtifactService nested filenames', () => {
    let service: BaseArtifactService;

    beforeEach(async () => {
      service = await gcsLane.create();
    });

    afterEach(async () => {
      await gcsLane.cleanup();
    });

    it('keeps a nested artifact out of its parent version list', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'doc',
        artifact: {text: 'parent v0'},
      });
      // The nested artifact gets more versions than the parent has, so a leak
      // pushes the parent's max version past any version it owns.
      for (let i = 0; i < 3; i++) {
        await service.saveArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'doc/nested',
          artifact: {text: `nested v${i}`},
        });
      }

      expect(
        await service.listVersions({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'doc',
        }),
      ).toEqual([0]);

      // A load without a version resolves the highest one. A leaked version
      // addresses a blob that does not exist, so the load silently yields
      // undefined.
      const parent = await service.loadArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'doc',
      });
      expect(parent?.text).toBe('parent v0');

      expect(
        await service.saveArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'doc',
          artifact: {text: 'parent v1'},
        }),
      ).toBe(1);

      expect(
        await service.listVersions({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'doc/nested',
        }),
      ).toEqual([0, 1, 2]);
    });

    it('keeps nested version metadata out of the parent version handles', async () => {
      for (const filename of ['doc', 'doc/nested']) {
        await service.saveArtifact({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename,
          artifact: {text: filename},
        });
      }

      const versions = await service.listArtifactVersions({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'doc',
      });

      expect(versions.map((version) => version.version)).toEqual([0]);
      // The returned handle must address "doc", not the nested artifact.
      expect(versions[0].canonicalUri?.endsWith('/doc/0')).toBe(true);
    });
  });

  // Deleting "doc" must leave "doc/nested" alone. The file service removes the
  // directory that also holds the nested artifact. The GCS service keeps the
  // nested blob, but still reports it as a version of the deleted parent. The
  // in-memory service is already correct.
  describe.each([gcsLane, fileLane])('$name delete', (lane) => {
    let service: BaseArtifactService;

    beforeEach(async () => {
      service = await lane.create();
    });

    afterEach(async () => {
      await lane.cleanup();
    });

    it('keeps an artifact nested under the deleted one', async () => {
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'doc',
        artifact: {text: 'parent v0'},
      });
      await service.saveArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'doc/nested',
        artifact: {text: 'nested v0'},
      });

      await service.deleteArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'doc',
      });

      expect(
        await service.listVersions({
          appName: APP_NAME,
          userId: USER_ID,
          sessionId: SESSION_ID,
          filename: 'doc',
        }),
      ).toEqual([]);

      const nested = await service.loadArtifact({
        appName: APP_NAME,
        userId: USER_ID,
        sessionId: SESSION_ID,
        filename: 'doc/nested',
      });
      expect(nested?.text).toBe('nested v0');
    });
  });

  // FileArtifactService accepts appName on every request and never puts it in
  // the on-disk path, so two apps over one root share their artifacts.
  describe.each([{filename: 'report.txt'}, {filename: 'user:profile.txt'}])(
    'FileArtifactService app isolation ($filename)',
    ({filename}) => {
      const userId = 'user';
      const sessionId = 'session';
      let service: BaseArtifactService;

      beforeEach(async () => {
        service = await fileLane.create();
      });

      afterEach(async () => {
        await fileLane.cleanup();
      });

      it('keeps every operation inside its own app', async () => {
        const scope = {userId, sessionId, filename};

        expect(
          await service.saveArtifact({
            appName: 'app-a',
            ...scope,
            artifact: {text: 'secret-a'},
          }),
        ).toBe(0);

        expect(
          await service.loadArtifact({appName: 'app-b', ...scope}),
        ).toBeUndefined();
        expect(
          await service.listArtifactKeys({appName: 'app-b', userId, sessionId}),
        ).toEqual([]);
        expect(
          await service.listVersions({appName: 'app-b', ...scope}),
        ).toEqual([]);
        expect(
          await service.listArtifactVersions({appName: 'app-b', ...scope}),
        ).toEqual([]);
        expect(
          await service.getArtifactVersion({appName: 'app-b', ...scope}),
        ).toBeUndefined();

        expect(
          await service.saveArtifact({
            appName: 'app-b',
            ...scope,
            artifact: {text: 'secret-b'},
          }),
        ).toBe(0);
        expect(
          (await service.loadArtifact({appName: 'app-a', ...scope}))?.text,
        ).toBe('secret-a');

        await service.deleteArtifact({appName: 'app-b', ...scope});
        expect(
          await service.loadArtifact({appName: 'app-b', ...scope}),
        ).toBeUndefined();
        expect(
          (await service.loadArtifact({appName: 'app-a', ...scope}))?.text,
        ).toBe('secret-a');
      });
    },
  );
});
