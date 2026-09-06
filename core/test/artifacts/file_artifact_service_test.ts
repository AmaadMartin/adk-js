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

  describe('metadata tampering', () => {
    const appName = 'test-app';
    const userId = 'test-user';
    const sessionId = 'test-session';
    const artifactName = 'poisoned.txt';

    /**
     * Writes a version directory that holds a tampered metadata document and
     * no payload, which is the state a delete between listing and reading
     * leaves behind. Returns that version directory.
     */
    async function writeTamperedMetadata(
      root: string,
      canonicalUri: string,
    ): Promise<string> {
      const versionDir = path.join(
        getSessionArtifactsDir(getUserRoot(root, userId), sessionId),
        artifactName,
        'versions',
        '0',
      );
      await fs.mkdir(versionDir, {recursive: true});
      await fs.writeFile(
        path.join(versionDir, 'metadata.json'),
        JSON.stringify({
          fileName: artifactName,
          version: 0,
          canonicalUri,
          customMetadata: {},
        }),
        'utf-8',
      );
      return versionDir;
    }

    it('loadArtifact ignores canonicalUri from metadata', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'adk-artifacts-secret-'),
      );

      try {
        const secretPath = path.join(outsideDir, 'secret.txt');
        await fs.writeFile(secretPath, 'TOP-SECRET', 'utf-8');
        await writeTamperedMetadata(
          rootDir,
          pathToFileURL(secretPath).toString(),
        );

        const service = new FileArtifactService(rootDir);
        const loaded = await service.loadArtifact({
          appName,
          userId,
          sessionId,
          filename: artifactName,
        });

        expect(loaded).toBeUndefined();
      } finally {
        await fs.rm(rootDir, {recursive: true, force: true});
        await fs.rm(outsideDir, {recursive: true, force: true});
      }
    });

    it('getArtifactVersion ignores canonicalUri from metadata', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));

      try {
        const versionDir = await writeTamperedMetadata(
          rootDir,
          'file:///etc/passwd',
        );

        const service = new FileArtifactService(rootDir);
        const artifactVersion = await service.getArtifactVersion({
          appName,
          userId,
          sessionId,
          filename: artifactName,
          version: 0,
        });

        expect(artifactVersion?.version).toBe(0);
        expect(artifactVersion?.canonicalUri).toBe(
          pathToFileURL(path.join(versionDir, artifactName)).toString(),
        );
      } finally {
        await fs.rm(rootDir, {recursive: true, force: true});
      }
    });

    it('listArtifactVersions ignores canonicalUri from metadata', async () => {
      rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-test-'));

      try {
        const versionDir = await writeTamperedMetadata(
          rootDir,
          'file:///etc/passwd',
        );

        const service = new FileArtifactService(rootDir);
        const artifactVersions = await service.listArtifactVersions({
          appName,
          userId,
          sessionId,
          filename: artifactName,
        });

        expect(artifactVersions).toHaveLength(1);
        expect(artifactVersions[0].version).toBe(0);
        expect(artifactVersions[0].canonicalUri).toBe(
          pathToFileURL(path.join(versionDir, artifactName)).toString(),
        );
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
