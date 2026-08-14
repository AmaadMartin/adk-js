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
            getUserRoot(rootDir, appName, userId),
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
    const APP = 'test-app';

    describe('validatePathSegment - valid inputs', () => {
      it('allows a plain alphanumeric userId', () => {
        expect(() => getUserRoot(ROOT, APP, 'alice')).not.toThrow();
      });
      it('allows a UUID as userId', () => {
        expect(() =>
          getUserRoot(ROOT, APP, '550e8400-e29b-41d4-a716-446655440000'),
        ).not.toThrow();
      });
      it('allows an email-style userId', () => {
        expect(() => getUserRoot(ROOT, APP, 'user.name@org')).not.toThrow();
      });
      it('allows a plain alphanumeric sessionId', () => {
        expect(() =>
          getSessionArtifactsDir(`${ROOT}/users/alice`, 'session-abc123'),
        ).not.toThrow();
      });
    });

    describe('deny-list accepts what the allow-list rejected', () => {
      it('allows a forward slash in userId', () => {
        expect(() => getUserRoot(ROOT, APP, 'a/b')).not.toThrow();
      });
      it('allows a percent-encoded slash in userId', () => {
        expect(() => getUserRoot(ROOT, APP, '..%2F..%2Fetc')).not.toThrow();
      });
      it('allows a percent-encoded slash in sessionId', () => {
        expect(() =>
          getSessionArtifactsDir(
            `${ROOT}/users/alice`,
            '..%2F..%2F..%2Fsecret',
          ),
        ).not.toThrow();
      });
      it('allows a space in userId', () => {
        expect(() => getUserRoot(ROOT, APP, 'user id')).not.toThrow();
      });
      it('allows a colon in sessionId', () => {
        expect(() =>
          getSessionArtifactsDir(`${ROOT}/users/alice`, 'sess:42'),
        ).not.toThrow();
      });
    });

    describe('validatePathSegment - appName attacks', () => {
      it('blocks a traversal appName even though it is not joined into the path', () => {
        expect(() => getUserRoot(ROOT, '../escape', 'alice')).toThrow(
          "appName '../escape' must not contain traversal segments.",
        );
      });
      it('blocks a drive-qualified appName', () => {
        expect(() => getUserRoot(ROOT, 'C:evil', 'alice')).toThrow(
          "appName 'C:evil' must not be drive-qualified.",
        );
      });
    });

    describe('validatePathSegment - userId attacks', () => {
      it('blocks dot-dot-slash traversal in userId', () => {
        expect(() => getUserRoot(ROOT, APP, '../../etc')).toThrow(
          "userId '../../etc' must not contain traversal segments.",
        );
      });
      it('blocks a leading slash in userId', () => {
        expect(() => getUserRoot(ROOT, APP, '/etc/passwd')).toThrow(
          "userId '/etc/passwd' must not be an absolute path or start with a slash.",
        );
      });
      it('blocks null byte in userId', () => {
        expect(() => getUserRoot(ROOT, APP, 'alice\x00')).toThrow(
          'userId must not contain null bytes.',
        );
      });
      it('blocks empty string as userId', () => {
        expect(() => getUserRoot(ROOT, APP, '')).toThrow(
          'userId must not be empty.',
        );
      });
    });

    describe('validatePathSegment - sessionId attacks', () => {
      const base = `${ROOT}/users/alice`;
      it('blocks dot-dot-slash traversal in sessionId', () => {
        expect(() => getSessionArtifactsDir(base, '../../../secret')).toThrow(
          "sessionId '../../../secret' must not contain traversal segments.",
        );
      });
      it('blocks forward slash traversal in sessionId', () => {
        expect(() => getSessionArtifactsDir(base, 'sess/../../etc')).toThrow(
          "sessionId 'sess/../../etc' must not contain traversal segments.",
        );
      });
      it('blocks empty string as sessionId', () => {
        expect(() => getSessionArtifactsDir(base, '')).toThrow(
          'sessionId must not be empty.',
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
