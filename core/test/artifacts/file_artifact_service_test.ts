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
  getAppRoot,
  getSessionArtifactsDir,
  getUserRoot,
  iterateArtifactDirs,
  reserveVersionDir,
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
        expect((e as Error).message).toContain(
          'must not contain parent traversal',
        );
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
      it('throws when a sibling merely shares the root prefix', () => {
        expect(() =>
          assertInsideRoot('/tmp/root-evil/secret', '/tmp/root', 'test'),
        ).toThrow('escapes storage root');
      });
    });
  });

  describe('degraded on-disk states', () => {
    const appName = 'test-app';
    const userId = 'test-user';
    const sessionId = 'test-session';
    let root: string;
    let service: FileArtifactService;

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-artifacts-edge-'));
      service = new FileArtifactService(root);
    });

    afterEach(async () => {
      await fs.rm(root, {recursive: true, force: true});
    });

    /** Builds the app-scoped session artifact directory for a filename. */
    function artifactDir(...segments: string[]): string {
      return path.join(
        getSessionArtifactsDir(
          getUserRoot(getAppRoot(root, appName), userId),
          sessionId,
        ),
        ...segments,
      );
    }

    it('accepts a file:// root URI', async () => {
      const uriService = new FileArtifactService(
        pathToFileURL(root).toString(),
      );
      const scope = {appName, userId, sessionId, filename: 'uri.txt'};

      await uriService.saveArtifact({...scope, artifact: {text: 'from-uri'}});

      expect((await service.loadArtifact(scope))?.text).toBe('from-uri');
    });

    it('rejects a file:// root URI that is not a path', () => {
      // An encoded separator is rejected by fileURLToPath on every platform,
      // unlike a remote host, which Windows accepts as a UNC path.
      expect(() => new FileArtifactService('file:///a%2Fb')).toThrow(
        'Invalid root directory',
      );
    });

    it('stores an artifact whose name resolves to the scope root itself', async () => {
      const scope = {appName, userId, sessionId, filename: '.'};

      await service.saveArtifact({...scope, artifact: {text: 'fallback'}});

      expect((await service.loadArtifact(scope))?.text).toBe('fallback');
      await expect(fs.stat(artifactDir('artifact'))).resolves.toBeDefined();
    });

    it('defaults the mimeType when inlineData omits it', async () => {
      const scope = {appName, userId, sessionId, filename: 'blob.bin'};

      await service.saveArtifact({
        ...scope,
        artifact: {inlineData: {data: Buffer.from('x').toString('base64')}},
      });

      const version = await service.getArtifactVersion(scope);
      expect(version?.mimeType).toBe('application/octet-stream');
    });

    it('rejects fileData that carries no fileUri', async () => {
      await expect(
        service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename: 'pointer.pdf',
          artifact: {fileData: {mimeType: 'application/pdf'}},
        }),
      ).rejects.toThrow('fileData must have a fileUri');
    });

    it('propagates a reservation failure that is not a version collision', async () => {
      await expect(
        reserveVersionDir(path.join(root, 'missing', 'versions'), 0),
      ).rejects.toThrow(/ENOENT/);
    });

    it('returns undefined when the payload path is a directory', async () => {
      const versionDir = artifactDir('doc.bin', 'versions', '0');
      await fs.mkdir(path.join(versionDir, 'doc.bin'), {recursive: true});
      await fs.writeFile(
        path.join(versionDir, 'metadata.json'),
        JSON.stringify({
          fileName: 'doc.bin',
          mimeType: 'image/png',
          version: 0,
        }),
        'utf-8',
      );

      await expect(
        service.loadArtifact({
          appName,
          userId,
          sessionId,
          filename: 'doc.bin',
        }),
      ).resolves.toBeUndefined();
    });

    it('reports no versions when the versions path is a file', async () => {
      await fs.mkdir(artifactDir('broken.txt'), {recursive: true});
      await fs.writeFile(artifactDir('broken.txt', 'versions'), '', 'utf-8');

      await expect(
        service.listVersions({
          appName,
          userId,
          sessionId,
          filename: 'broken.txt',
        }),
      ).resolves.toEqual([]);
    });

    it('lists an artifact whose versions directory holds nothing', async () => {
      await fs.mkdir(artifactDir('ghost', 'versions'), {recursive: true});

      await expect(
        service.listArtifactKeys({appName, userId, sessionId}),
      ).resolves.toEqual(['ghost']);
    });

    it('leaves the scope root in place after the last artifact goes', async () => {
      const scope = {appName, userId, sessionId, filename: 'only.txt'};
      await service.saveArtifact({...scope, artifact: {text: 'x'}});

      await service.deleteArtifact(scope);

      // Pruning walks up from the artifact directory and must stop below the
      // scope root, which later saves and listings still need.
      await expect(fs.stat(artifactDir())).resolves.toBeDefined();
      await expect(fs.stat(artifactDir('only.txt'))).rejects.toThrow();
    });

    it('walks each artifact directory exactly once', async () => {
      // 'doc' is an artifact and also the parent of 'doc/nested', so the walk
      // both yields it and descends into it. listArtifactKeys dedupes through
      // a Set, so only the walk itself shows a directory visited twice.
      for (const filename of ['doc', 'doc/nested']) {
        await service.saveArtifact({
          appName,
          userId,
          sessionId,
          filename,
          artifact: {text: filename},
        });
      }

      const walked: string[] = [];
      for await (const dir of iterateArtifactDirs(artifactDir())) {
        walked.push(dir);
      }

      expect(walked).toEqual([
        artifactDir('doc'),
        artifactDir('doc', 'nested'),
      ]);
    });
  });
});
