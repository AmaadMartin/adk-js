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

    const ROOT = '/tmp/adk-test-root';

    describe('validatePathSegment - valid inputs', () => {
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

    describe('layout is unchanged for identifiers the allow-list accepted', () => {
      it('joins an email-style userId verbatim', () => {
        expect(getUserRoot(ROOT, 'user.name@org')).toBe(
          path.join(ROOT, 'users', 'user.name@org'),
        );
      });
      it('joins a UUID sessionId verbatim', () => {
        expect(
          getSessionArtifactsDir(`${ROOT}/users/alice`, 'session-abc123'),
        ).toBe(
          path.join(
            ROOT,
            'users',
            'alice',
            'sessions',
            'session-abc123',
            'artifacts',
          ),
        );
      });
    });

    describe('deny-list accepts what the allow-list rejected', () => {
      it('keeps a forward-slashed userId in one path segment', () => {
        expect(getUserRoot(ROOT, 'a/b')).toBe(
          path.join(ROOT, 'users', 'a%2Fb'),
        );
      });
      it('keeps a back-slashed userId in one path segment', () => {
        expect(getUserRoot(ROOT, 'a\\b')).toBe(
          path.join(ROOT, 'users', 'a%5Cb'),
        );
      });
      it('escapes a literal percent so an escape cannot be forged', () => {
        expect(getUserRoot(ROOT, 'a%2Fb')).toBe(
          path.join(ROOT, 'users', 'a%252Fb'),
        );
        expect(getUserRoot(ROOT, 'a%2Fb')).not.toBe(getUserRoot(ROOT, 'a/b'));
      });
      it('allows a percent-encoded slash in userId', () => {
        expect(() => getUserRoot(ROOT, '..%2F..%2Fetc')).not.toThrow();
      });
      it('keeps a forward-slashed sessionId in one path segment', () => {
        expect(getSessionArtifactsDir(`${ROOT}/users/alice`, 'a/b')).toBe(
          path.join(ROOT, 'users', 'alice', 'sessions', 'a%2Fb', 'artifacts'),
        );
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
        expect(() => getUserRoot(ROOT, 'user id')).not.toThrow();
      });
      it('allows a colon in sessionId', () => {
        expect(() =>
          getSessionArtifactsDir(`${ROOT}/users/alice`, 'sess:42'),
        ).not.toThrow();
      });
    });

    it('does not let a slash-bearing userId read another scope', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const service = new FileArtifactService(rootDir);

      try {
        await service.saveArtifact({
          appName: 'test-app',
          userId: 'alice',
          sessionId: 's1',
          filename: 'secret.txt',
          artifact: {text: 'session-scoped secret'},
        });

        const stolen = await service.loadArtifact({
          appName: 'test-app',
          userId: 'alice/sessions/s1',
          sessionId: 'unused',
          filename: 'user:secret.txt',
        });

        expect(stolen).toBeUndefined();
      } finally {
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    });

    describe('validatePathSegment - userId attacks', () => {
      it('blocks dot-dot-slash traversal in userId', () => {
        expect(() => getUserRoot(ROOT, '../../etc')).toThrow(
          "userId '../../etc' must not contain traversal segments.",
        );
      });
      it('blocks a leading slash in userId', () => {
        expect(() => getUserRoot(ROOT, '/etc/passwd')).toThrow(
          "userId '/etc/passwd' must not be an absolute path or start with a slash.",
        );
      });
      it('blocks null byte in userId', () => {
        expect(() => getUserRoot(ROOT, 'alice\x00')).toThrow(
          'userId must not contain null bytes.',
        );
      });
      it('blocks empty string as userId', () => {
        expect(() => getUserRoot(ROOT, '')).toThrow(
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
