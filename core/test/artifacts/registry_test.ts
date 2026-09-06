/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FileArtifactService,
  GcsArtifactService,
  InMemoryArtifactService,
  getArtifactServiceFromUri,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {
  getSessionArtifactsDir,
  getUserRoot,
} from '../../src/artifacts/file_artifact_service.js';

const IS_WINDOWS = os.platform() === 'win32';

describe('getArtifactServiceFromUri', () => {
  it('returns InMemoryArtifactService for memory uri', () => {
    const service = getArtifactServiceFromUri('memory://');
    expect(service).toBeInstanceOf(InMemoryArtifactService);
  });

  it('returns GcsArtifactService for gs uri', () => {
    const service = getArtifactServiceFromUri('gs://my-bucket');
    expect(service).toBeInstanceOf(GcsArtifactService);
    // The GCS client is an optional peer loaded on first use, so the bucket
    // handle does not exist until then; the parsed name is what the registry
    // is responsible for and it is all that can be asserted synchronously.
    expect((service as unknown as {bucketName: string}).bucketName).toBe(
      'my-bucket',
    );
  });

  // A driveless path is not a valid Windows file URL, so Node rejects
  // `file:///tmp/artifacts` on win32.
  it.skipIf(IS_WINDOWS)('returns FileArtifactService for file uri', () => {
    const service = getArtifactServiceFromUri('file:///tmp/artifacts');
    expect(service).toBeInstanceOf(FileArtifactService);
  });

  it.skipIf(!IS_WINDOWS)('rejects a driveless file uri on Windows', () => {
    expect(() => getArtifactServiceFromUri('file:///tmp/artifacts')).toThrow(
      /Invalid root directory/,
    );
  });

  it.skipIf(!IS_WINDOWS)(
    'returns FileArtifactService for a Windows drive-letter file uri',
    () => {
      const service = getArtifactServiceFromUri('file:///C:/tmp/adk-artifacts');
      expect(service).toBeInstanceOf(FileArtifactService);
    },
  );

  // Skipped on Windows, where `file://host/share` is a legitimate UNC path.
  it.skipIf(IS_WINDOWS)(
    'reports a clear error for a file uri with a remote host',
    () => {
      expect(() => getArtifactServiceFromUri('file://some-host/share')).toThrow(
        /Invalid root directory/,
      );
    },
  );

  it('saves artifacts under the directory a file URI names', async () => {
    // The space makes `pathToFileURL` percent-encode the root on every
    // platform, so this also pins percent-decoding.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk artifacts-'));
    const userId = 'test-user';
    const sessionId = 'test-session';

    try {
      const service = getArtifactServiceFromUri(pathToFileURL(dir).toString());

      await service.saveArtifact({
        appName: 'test-app',
        userId,
        sessionId,
        filename: 'note.txt',
        artifact: {text: 'hello'},
      });

      const contentPath = path.join(
        getSessionArtifactsDir(getUserRoot(dir, userId), sessionId),
        'note.txt',
        'versions',
        '0',
        'note.txt',
      );
      expect(await fs.readFile(contentPath, 'utf-8')).toBe('hello');
    } finally {
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  it('throws error for unsupported uri', () => {
    expect(() => getArtifactServiceFromUri('unsupported://uri')).toThrow(
      'Unsupported artifact service URI: unsupported://uri',
    );
  });
});
