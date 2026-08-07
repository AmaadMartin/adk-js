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

const APP_NAME = 'test-app';
const USER_ID = 'test-user';
const SESSION_ID = 'test-session';

/**
 * Runs `body` against a service backed by a fresh temporary root directory,
 * then removes that directory.
 */
async function withArtifactService(
  body: (service: FileArtifactService, serviceRoot: string) => Promise<void>,
): Promise<void> {
  const serviceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'adk-artifacts-test-'),
  );
  try {
    await body(new FileArtifactService(serviceRoot), serviceRoot);
  } finally {
    await fs.rm(serviceRoot, {recursive: true, force: true});
  }
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

    describe('host-independent filename rooting', () => {
      it('rejects a Windows drive-absolute filename', async () => {
        await withArtifactService(async (service) => {
          await expect(
            service.saveArtifact({
              appName: APP_NAME,
              userId: USER_ID,
              sessionId: SESSION_ID,
              filename: 'C:\\evil.txt',
              artifact: {text: 'x'},
            }),
          ).rejects.toThrow(
            'Absolute artifact filename C:\\evil.txt is not permitted.',
          );
        });
      });

      it('rejects a Windows root-relative filename', async () => {
        await withArtifactService(async (service) => {
          await expect(
            service.saveArtifact({
              appName: APP_NAME,
              userId: USER_ID,
              sessionId: SESSION_ID,
              filename: '\\evil.txt',
              artifact: {text: 'x'},
            }),
          ).rejects.toThrow(
            'Absolute artifact filename \\evil.txt is not permitted.',
          );
        });
      });

      it('rejects a Windows drive-relative filename', async () => {
        await withArtifactService(async (service) => {
          await expect(
            service.saveArtifact({
              appName: APP_NAME,
              userId: USER_ID,
              sessionId: SESSION_ID,
              filename: 'C:evil.txt',
              artifact: {text: 'x'},
            }),
          ).rejects.toThrow(
            'Absolute artifact filename C:evil.txt is not permitted.',
          );
        });
      });

      it('rejects traversal expressed with Windows separators', async () => {
        await withArtifactService(async (service) => {
          await expect(
            service.saveArtifact({
              appName: APP_NAME,
              userId: USER_ID,
              sessionId: SESSION_ID,
              filename: '..\\escape.txt',
              artifact: {text: 'x'},
            }),
          ).rejects.toThrow('escapes storage directory');
        });
      });

      it('rejects nested traversal expressed with Windows separators', async () => {
        await withArtifactService(async (service) => {
          await expect(
            service.saveArtifact({
              appName: APP_NAME,
              userId: USER_ID,
              sessionId: SESSION_ID,
              filename: 'sub\\..\\..\\escape.txt',
              artifact: {text: 'x'},
            }),
          ).rejects.toThrow('escapes storage directory');
        });
      });

      it('nests a filename that uses Windows separators', async () => {
        await withArtifactService(async (service, serviceRoot) => {
          await service.saveArtifact({
            appName: APP_NAME,
            userId: USER_ID,
            sessionId: SESSION_ID,
            filename: 'sub\\file.txt',
            artifact: {text: 'hello'},
          });

          const versionDir = path.join(
            getSessionArtifactsDir(
              getUserRoot(serviceRoot, USER_ID),
              SESSION_ID,
            ),
            'sub',
            'file.txt',
            'versions',
            '0',
          );
          await expect(fs.access(versionDir)).resolves.toBeUndefined();
          expect((await fs.readdir(versionDir)).sort()).toEqual([
            'file.txt',
            'metadata.json',
          ]);

          const loaded = await service.loadArtifact({
            appName: APP_NAME,
            userId: USER_ID,
            sessionId: SESSION_ID,
            filename: 'sub\\file.txt',
          });
          expect(loaded?.text).toBe('hello');
        });
      });
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
