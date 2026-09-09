/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FileArtifactService} from '@google/adk';
import * as fs from 'fs/promises';
import {pathToFileURL} from 'node:url';
import * as os from 'os';
import * as path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  assertInsideRoot,
  getBaseRoot,
  getSessionArtifactsDir,
} from '../../src/artifacts/file_artifact_service.js';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';

const SCOPE = {
  userId: 'user',
  sessionId: 'session',
  filename: 'report.txt',
};

/**
 * Writes an artifact in the layout used before storage was app-scoped.
 *
 * @param root The artifact root directory.
 * @param texts The payload of each version, in version order.
 * @returns The directory holding the artifact.
 */
async function writeUnscopedArtifact(
  root: string,
  ...texts: string[]
): Promise<string> {
  const artifactDir = path.join(
    root,
    'users',
    SCOPE.userId,
    'sessions',
    SCOPE.sessionId,
    'artifacts',
    SCOPE.filename,
  );
  for (const [version, text] of texts.entries()) {
    const versionDir = path.join(artifactDir, 'versions', String(version));
    await fs.mkdir(versionDir, {recursive: true});
    const payloadPath = path.join(versionDir, SCOPE.filename);
    await fs.writeFile(payloadPath, text, 'utf-8');
    await fs.writeFile(
      path.join(versionDir, 'metadata.json'),
      JSON.stringify({
        fileName: SCOPE.filename,
        version,
        canonicalUri: pathToFileURL(payloadPath).toString(),
      }),
      'utf-8',
    );
  }
  return artifactDir;
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
          getSessionArtifactsDir(
            getBaseRoot(rootDir, appName, userId),
            sessionId,
          ),
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
        expect(() => getBaseRoot(ROOT, 'app', 'alice')).not.toThrow();
      });
      it('allows a UUID as userId', () => {
        expect(() =>
          getBaseRoot(ROOT, 'app', '550e8400-e29b-41d4-a716-446655440000'),
        ).not.toThrow();
      });
      it('allows an email-style userId', () => {
        expect(() => getBaseRoot(ROOT, 'app', 'user.name@org')).not.toThrow();
      });
      it('allows a plain alphanumeric sessionId', () => {
        expect(() =>
          getSessionArtifactsDir(
            `${ROOT}/apps/app/users/alice`,
            'session-abc123',
          ),
        ).not.toThrow();
      });
    });

    describe('assertSafeSegment - userId attacks', () => {
      it('blocks dot-dot-slash traversal in userId', () => {
        expect(() => getBaseRoot(ROOT, 'app', '../../etc')).toThrow(
          'Invalid userId',
        );
      });
      it('blocks forward slash in userId', () => {
        expect(() => getBaseRoot(ROOT, 'app', 'a/b')).toThrow('Invalid userId');
      });
      it('blocks percent-encoded slash in userId', () => {
        expect(() => getBaseRoot(ROOT, 'app', '..%2F..%2Fetc')).toThrow(
          'Invalid userId',
        );
      });
      it('blocks null byte in userId', () => {
        expect(() => getBaseRoot(ROOT, 'app', 'alice\x00')).toThrow(
          'Invalid userId',
        );
      });
      it('blocks empty string as userId', () => {
        expect(() => getBaseRoot(ROOT, 'app', '')).toThrow('Invalid userId');
      });
    });

    describe('assertSafeSegment - sessionId attacks', () => {
      const base = `${ROOT}/apps/app/users/alice`;
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

    describe('assertSafeSegment - appName attacks', () => {
      it('blocks dot-dot-slash traversal in appName', () => {
        expect(() => getBaseRoot(ROOT, '../../etc', 'alice')).toThrow(
          'Invalid appName',
        );
      });
      it('blocks forward slash in appName', () => {
        expect(() => getBaseRoot(ROOT, 'a/b', 'alice')).toThrow(
          'Invalid appName',
        );
      });
      it('blocks empty string as appName', () => {
        expect(() => getBaseRoot(ROOT, '', 'alice')).toThrow('Invalid appName');
      });
      it('reports an invalid appName before an invalid userId', () => {
        expect(() => getBaseRoot(ROOT, 'a/b', 'c/d')).toThrow(
          'Invalid appName',
        );
      });
    });
  });

  describe('app-scoped storage', () => {
    let root: string;
    let service: FileArtifactService;

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-app-scope-test-'));
      service = new FileArtifactService(root);
    });

    afterEach(async () => {
      await fs.rm(root, {recursive: true, force: true});
    });

    it('stores an artifact under apps/{appName}/users/{userId}', async () => {
      await service.saveArtifact({
        ...SCOPE,
        appName: 'app-a',
        artifact: {text: 'secret-a'},
      });

      const versionDir = path.join(
        root,
        'apps',
        'app-a',
        'users',
        'user',
        'sessions',
        'session',
        'artifacts',
        'report.txt',
        'versions',
        '0',
      );
      expect(
        await fs.readFile(path.join(versionDir, 'report.txt'), 'utf-8'),
      ).toBe('secret-a');
      const metadata = JSON.parse(
        await fs.readFile(path.join(versionDir, 'metadata.json'), 'utf-8'),
      ) as {fileName?: string};
      expect(metadata.fileName).toBe('report.txt');
    });

    it('rejects a save whose appName traverses out of the root', async () => {
      await expect(
        service.saveArtifact({
          ...SCOPE,
          appName: '../../etc',
          artifact: {text: 'secret-a'},
        }),
      ).rejects.toThrow('Invalid appName');
    });

    for (const appName of ['app-a', 'app-b']) {
      it(`never serves the pre-app-scoped tree to ${appName}`, async () => {
        await writeUnscopedArtifact(root, 'older', 'legacy');

        expect(await service.loadArtifact({...SCOPE, appName})).toBeUndefined();
        expect(await service.listVersions({...SCOPE, appName})).toEqual([]);
        expect(await service.listArtifactVersions({...SCOPE, appName})).toEqual(
          [],
        );
        expect(
          await service.getArtifactVersion({...SCOPE, appName}),
        ).toBeUndefined();
        expect(
          await service.listArtifactKeys({
            appName,
            userId: SCOPE.userId,
            sessionId: SCOPE.sessionId,
          }),
        ).not.toContain(SCOPE.filename);
      });
    }

    it('saves alongside the pre-app-scoped tree instead of extending it', async () => {
      await writeUnscopedArtifact(root, 'older', 'legacy');

      expect(
        await service.saveArtifact({
          ...SCOPE,
          appName: 'app-a',
          artifact: {text: 'current'},
        }),
      ).toBe(0);
      await expect(
        fs.access(path.join(root, 'apps', 'app-a', 'users', 'user')),
      ).resolves.toBeUndefined();
      expect(
        (await service.loadArtifact({...SCOPE, appName: 'app-a'}))?.text,
      ).toBe('current');
      expect(await service.listVersions({...SCOPE, appName: 'app-a'})).toEqual([
        0,
      ]);
      expect(
        await service.loadArtifact({...SCOPE, appName: 'app-a', version: 1}),
      ).toBeUndefined();
    });

    it('deletes only the calling app copy', async () => {
      const unscopedDir = await writeUnscopedArtifact(root, 'legacy');
      await service.saveArtifact({
        ...SCOPE,
        appName: 'app-a',
        artifact: {text: 'secret-a'},
      });

      await service.deleteArtifact({...SCOPE, appName: 'app-b'});

      await expect(fs.access(unscopedDir)).resolves.toBeUndefined();
      expect(
        (await service.loadArtifact({...SCOPE, appName: 'app-a'}))?.text,
      ).toBe('secret-a');
      expect(await service.listVersions({...SCOPE, appName: 'app-a'})).toEqual([
        0,
      ]);
    });
  });
});
