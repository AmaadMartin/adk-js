/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FileArtifactService} from '@google/adk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {describe, expect, it} from 'vitest';
import {
  assertInsideRoot,
  getSessionArtifactsDir,
  getUserRoot,
} from '../../src/artifacts/file_artifact_service.js';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';

const ALIASED_KEY = {
  appName: 'test-app',
  userId: 'test-user',
  sessionId: 'test-session',
};

/**
 * Saves `Report.txt`, then rewrites the layout into the state a
 * case-insensitive host presents: one directory reachable under either
 * spelling, storing the key the artifact was saved under.
 */
async function saveAliasedArtifact(
  service: FileArtifactService,
  rootDir: string,
): Promise<void> {
  await service.saveArtifact({
    ...ALIASED_KEY,
    filename: 'Report.txt',
    artifact: {text: 'first'},
  });

  const scopeRoot = getSessionArtifactsDir(
    getUserRoot(rootDir, ALIASED_KEY.userId),
    ALIASED_KEY.sessionId,
  );
  await fs.rename(
    path.join(scopeRoot, 'Report.txt'),
    path.join(scopeRoot, 'report.txt'),
  );
  await fs.rename(
    path.join(scopeRoot, 'report.txt', 'versions', '0', 'Report.txt'),
    path.join(scopeRoot, 'report.txt', 'versions', '0', 'report.txt'),
  );
}

describe('FileArtifactService', () => {
  let rootDir: string;

  runArtifactServiceTests(
    async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      await fs.mkdir(rootDir, {recursive: true});
      return new FileArtifactService(rootDir);
    },
    async () => {
      if (rootDir) {
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    },
  );

  describe('fileData storage', () => {
    it('stores fileData as a metadata-only pointer with no content file', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const service = new FileArtifactService(rootDir);
      const appName = 'test-app';
      const userId = 'test-user';
      const sessionId = 'test-session';

      try {
        await service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: 'report.pdf',
          artifact: {
            fileData: {
              fileUri: 'gs://my-bucket/report.pdf',
              mimeType: 'application/pdf',
            },
          },
        });

        const versionDir = path.join(
          getSessionArtifactsDir(getUserRoot(rootDir, userId), sessionId),
          'report.pdf',
          'versions',
          '0',
        );
        const entries = await fs.readdir(versionDir);

        expect(entries).toEqual(['metadata.json']);

        const loaded = await service.loadArtifact({
          appName,
          userId,
          sessionId,
          filename: 'report.pdf',
        });
        expect(loaded?.fileData?.fileUri).toBe('gs://my-bucket/report.pdf');
        expect(loaded?.fileData?.mimeType).toBe('application/pdf');
      } finally {
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    });
  });

  describe('listArtifactKeys without stored metadata', () => {
    it('recovers the key from the directory layout in each scope', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const service = new FileArtifactService(rootDir);

      try {
        const userRoot = getUserRoot(rootDir, ALIASED_KEY.userId);
        const sessionRoot = getSessionArtifactsDir(
          userRoot,
          ALIASED_KEY.sessionId,
        );
        await fs.mkdir(
          path.join(sessionRoot, 'nested', 'legacy.txt', 'versions', '0'),
          {recursive: true},
        );
        await fs.mkdir(
          path.join(userRoot, 'artifacts', 'legacy-user.txt', 'versions', '0'),
          {recursive: true},
        );

        const keys = await service.listArtifactKeys(ALIASED_KEY);
        expect(keys).toEqual(['nested/legacy.txt', 'user:legacy-user.txt']);
      } finally {
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    });
  });

  describe('case-insensitive filesystem aliasing', () => {
    const request = {...ALIASED_KEY, filename: 'report.txt'};

    it('reports not found for reads addressed by the other spelling', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const service = new FileArtifactService(rootDir);

      try {
        await saveAliasedArtifact(service, rootDir);

        expect(await service.loadArtifact(request)).toBeUndefined();
        expect(await service.listVersions(request)).toEqual([]);
        expect(await service.listArtifactVersions(request)).toEqual([]);
        expect(await service.getArtifactVersion(request)).toBeUndefined();
      } finally {
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    });

    it('keeps the stored artifact when deleting the other spelling', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const service = new FileArtifactService(rootDir);

      try {
        await saveAliasedArtifact(service, rootDir);

        await service.deleteArtifact(request);

        const keys = await service.listArtifactKeys(ALIASED_KEY);
        expect(keys).toContain('Report.txt');
      } finally {
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    });
  });

  describe('path security', () => {
    it('rejects traversal attempts', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const service = new FileArtifactService(rootDir);
      const appName = 'test-app';
      const userId = 'test-user';
      const sessionId = 'test-session';

      try {
        await service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: '../../secret.txt',
          artifact: {text: '.'},
        });
        expect.fail('Should have thrown');
      } catch (e: unknown) {
        expect((e as Error).message).toContain('escapes storage directory');
      } finally {
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    });

    const ROOT = '/tmp/adk-test-root';

    describe('assertSafeSegment - valid inputs', () => {
      it('allows a plain alphanumeric userId', () => {
        expect(() => getUserRoot(ROOT, 'alice')).not.toThrow();
      });
      it('allows a UUID as userId', () => {
        expect(() =>
          getUserRoot(ROOT, '550e8400-e29b-41d4-a716-446655440000'),
        ).not.toThrow();
      });
      it('allows an email-style userId', () => {
        expect(() => getUserRoot(ROOT, 'user.name@org')).not.toThrow();
      });
      it('allows a plain alphanumeric sessionId', () => {
        expect(() =>
          getSessionArtifactsDir(`${ROOT}/users/alice`, 'session-abc123'),
        ).not.toThrow();
      });
    });

    describe('assertSafeSegment - userId attacks', () => {
      it('blocks dot-dot-slash traversal in userId', () => {
        expect(() => getUserRoot(ROOT, '../../etc')).toThrow('Invalid userId');
      });
      it('blocks forward slash in userId', () => {
        expect(() => getUserRoot(ROOT, 'a/b')).toThrow('Invalid userId');
      });
      it('blocks percent-encoded slash in userId', () => {
        expect(() => getUserRoot(ROOT, '..%2F..%2Fetc')).toThrow(
          'Invalid userId',
        );
      });
      it('blocks null byte in userId', () => {
        expect(() => getUserRoot(ROOT, 'alice\x00')).toThrow('Invalid userId');
      });
      it('blocks empty string as userId', () => {
        expect(() => getUserRoot(ROOT, '')).toThrow('Invalid userId');
      });
    });

    describe('assertSafeSegment - sessionId attacks', () => {
      const base = `${ROOT}/users/alice`;
      it('blocks dot-dot-slash traversal in sessionId', () => {
        expect(() => getSessionArtifactsDir(base, '../../../secret')).toThrow(
          'Invalid sessionId',
        );
      });
      it('blocks forward slash in sessionId', () => {
        expect(() => getSessionArtifactsDir(base, 'sess/../../etc')).toThrow(
          'Invalid sessionId',
        );
      });
      it('blocks percent-encoded slash in sessionId', () => {
        expect(() =>
          getSessionArtifactsDir(base, '..%2F..%2F..%2Fsecret'),
        ).toThrow('Invalid sessionId');
      });
      it('blocks empty string as sessionId', () => {
        expect(() => getSessionArtifactsDir(base, '')).toThrow(
          'Invalid sessionId',
        );
      });
    });

    describe('assertInsideRoot - defence-in-depth', () => {
      it('throws when resolved path escapes root', () => {
        expect(() =>
          assertInsideRoot('/tmp/root/../outside', '/tmp/root', 'test'),
        ).toThrow('escapes storage root');
      });
      it('allows a path equal to root', () => {
        expect(() =>
          assertInsideRoot('/tmp/root', '/tmp/root', 'test'),
        ).not.toThrow();
      });
      it('allows a path nested inside root', () => {
        expect(() =>
          assertInsideRoot('/tmp/root/users/alice', '/tmp/root', 'test'),
        ).not.toThrow();
      });
    });
  });
});
