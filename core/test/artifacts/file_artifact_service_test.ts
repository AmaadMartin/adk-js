/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FileArtifactService} from '@google/adk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {pathToFileURL} from 'url';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  assertInsideRoot,
  getAppRoot,
  getSessionArtifactsDir,
  getUserRoot,
} from '../../src/artifacts/file_artifact_service.js';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';

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
            getUserRoot(getAppRoot(rootDir, appName), userId),
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

    it('stores a segment that merely starts with two dots', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const service = new FileArtifactService(rootDir);
      const scope = {
        appName: 'test-app',
        userId: 'test-user',
        sessionId: 'test-session',
        filename: '..hidden.txt',
      };

      try {
        await service.saveArtifact({...scope, artifact: {text: 'body'}});

        expect((await service.loadArtifact(scope))?.text).toBe('body');
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

  describe('error paths', () => {
    const appName = 'test-app';
    const userId = 'test-user';
    const sessionId = 'test-session';
    let errorRoot: string;
    let service: FileArtifactService;

    beforeEach(async () => {
      errorRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'adk-artifacts-errors-'),
      );
      service = new FileArtifactService(errorRoot);
    });

    afterEach(async () => {
      await fs.rm(errorRoot, {recursive: true, force: true});
    });

    /** Returns the directory an artifact is stored in. */
    function artifactDirOf(filename: string): string {
      return path.join(
        getSessionArtifactsDir(
          getUserRoot(getAppRoot(errorRoot, appName), userId),
          sessionId,
        ),
        filename,
      );
    }

    it('resolves a file:// root URI', async () => {
      const uriService = new FileArtifactService(
        pathToFileURL(errorRoot).toString(),
      );
      const version = await uriService.saveArtifact({
        appName,
        userId,
        sessionId,
        filename: 'via-uri.txt',
        artifact: {text: 'body'},
      });

      expect(version).toBe(0);
      expect(
        await fs.readFile(
          path.join(
            artifactDirOf('via-uri.txt'),
            'versions',
            '0',
            'via-uri.txt',
          ),
          'utf-8',
        ),
      ).toBe('body');
    });

    it('rejects a root URI that names a host', () => {
      expect(
        () => new FileArtifactService('file://elsewhere/artifacts'),
      ).toThrow('Invalid root directory');
    });

    it('rejects fileData with no fileUri', async () => {
      await expect(
        service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: 'pointer.pdf',
          artifact: {fileData: {mimeType: 'application/pdf', fileUri: ''}},
        }),
      ).rejects.toThrow('Artifact fileData must have a fileUri');
    });

    it('defaults the mime type when inlineData omits it', async () => {
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename: 'blob.bin',
        artifact: {inlineData: {data: Buffer.from('x').toString('base64')}},
      });

      const loaded = await service.loadArtifact({
        appName,
        userId,
        sessionId,
        filename: 'blob.bin',
      });
      expect(loaded?.inlineData?.mimeType).toBe('application/octet-stream');
    });

    it('stores an artifact whose name is only the user prefix under "artifact"', async () => {
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename: 'user:',
        artifact: {text: 'unnamed'},
      });

      expect(
        await service.listArtifactKeys({appName, userId, sessionId}),
      ).toEqual(['user:']);
      expect(
        (
          await service.loadArtifact({
            appName,
            userId,
            sessionId,
            filename: 'user:',
          })
        )?.text,
      ).toBe('unnamed');
    });

    it('degrades to no metadata when the document is not valid JSON', async () => {
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename: 'broken.txt',
        artifact: {text: 'body'},
      });
      await fs.writeFile(
        path.join(
          artifactDirOf('broken.txt'),
          'versions',
          '0',
          'metadata.json',
        ),
        'not json',
        'utf-8',
      );

      const version = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename: 'broken.txt',
      });
      expect(version?.version).toBe(0);
      expect(version?.mimeType).toBeUndefined();
    });

    it('degrades to undefined when the payload path names a directory', async () => {
      await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename: 'shadow.txt',
        artifact: {text: 'body'},
      });
      const payloadPath = path.join(
        artifactDirOf('shadow.txt'),
        'versions',
        '0',
        'shadow.txt',
      );
      await fs.rm(payloadPath);
      await fs.mkdir(payloadPath);

      expect(
        await service.loadArtifact({
          appName,
          userId,
          sessionId,
          filename: 'shadow.txt',
        }),
      ).toBeUndefined();
    });

    it('lists an artifact directory that holds no versions by its path', async () => {
      await fs.mkdir(path.join(artifactDirOf('stub.txt'), 'versions'), {
        recursive: true,
      });

      expect(
        await service.listArtifactKeys({appName, userId, sessionId}),
      ).toEqual(['stub.txt']);
    });

    // POSIX only: `fs.chmod` does not remove write access to a directory on
    // Windows, so the reservation would succeed there.
    it.skipIf(process.platform === 'win32')(
      'surfaces an error other than EEXIST while reserving a version',
      async () => {
        const versionsDir = path.join(artifactDirOf('locked.txt'), 'versions');
        await fs.mkdir(versionsDir, {recursive: true});
        await fs.chmod(versionsDir, 0o500);

        try {
          await expect(
            service.saveArtifact({
              appName,
              userId,
              sessionId,
              filename: 'locked.txt',
              artifact: {text: 'body'},
            }),
          ).rejects.toThrow('EACCES');
        } finally {
          await fs.chmod(versionsDir, 0o700);
        }
      },
    );

    // POSIX only, for the same reason as the test above.
    it.skipIf(process.platform === 'win32')(
      'treats an unreadable directory as empty when listing keys',
      async () => {
        const blocked = path.join(
          getSessionArtifactsDir(
            getUserRoot(getAppRoot(errorRoot, appName), userId),
            sessionId,
          ),
          'blocked',
        );
        await fs.mkdir(blocked, {recursive: true});
        await fs.chmod(blocked, 0o000);

        try {
          expect(
            await service.listArtifactKeys({appName, userId, sessionId}),
          ).toEqual([]);
        } finally {
          await fs.chmod(blocked, 0o700);
        }
      },
    );
  });
});
