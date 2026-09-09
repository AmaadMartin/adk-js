/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryArtifactService} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {runArtifactServiceTests} from './artifact_service_test_utils.js';

describe('InMemoryArtifactService', () => {
  runArtifactServiceTests(
    async () => new InMemoryArtifactService(),
    async () => {},
  );

  it('keeps artifacts with ambiguous path components isolated', async () => {
    const service = new InMemoryArtifactService();

    await service.saveArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'session',
      filename: 'nested/report.txt',
      artifact: {text: 'artifact-a'},
    });
    await service.saveArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'session/nested',
      filename: 'report.txt',
      artifact: {text: 'artifact-b'},
    });

    const artifactA = await service.loadArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'session',
      filename: 'nested/report.txt',
    });
    const artifactB = await service.loadArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'session/nested',
      filename: 'report.txt',
    });

    expect(artifactA?.text).toBe('artifact-a');
    expect(artifactB?.text).toBe('artifact-b');
  });

  it('keeps artifacts with ambiguous app and user components isolated', async () => {
    const service = new InMemoryArtifactService();

    await service.saveArtifact({
      appName: 'app',
      userId: 'nested/user',
      sessionId: 'session',
      filename: 'report.txt',
      artifact: {text: 'artifact-a'},
    });
    await service.saveArtifact({
      appName: 'app/nested',
      userId: 'user',
      sessionId: 'session',
      filename: 'report.txt',
      artifact: {text: 'artifact-b'},
    });

    const artifactA = await service.loadArtifact({
      appName: 'app',
      userId: 'nested/user',
      sessionId: 'session',
      filename: 'report.txt',
    });
    const artifactB = await service.loadArtifact({
      appName: 'app/nested',
      userId: 'user',
      sessionId: 'session',
      filename: 'report.txt',
    });

    expect(artifactA?.text).toBe('artifact-a');
    expect(artifactB?.text).toBe('artifact-b');
  });

  it('does not leak a session named user into other sessions', async () => {
    const service = new InMemoryArtifactService();

    await service.saveArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'user',
      filename: 'foo.txt',
      artifact: {text: 'session-scoped'},
    });

    const keys = await service.listArtifactKeys({
      appName: 'app',
      userId: 'user',
      sessionId: 'other',
    });

    expect(keys).toEqual([]);
  });

  describe('mimeType metadata', () => {
    const key = {appName: 'app', userId: 'user', sessionId: 'session'};
    const pngData =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgDNjd8qAAAAAElFTkSuQmCC';

    it('reports the mime type of inline data', async () => {
      const service = new InMemoryArtifactService();
      const filename = 'chart.png';

      await service.saveArtifact({
        ...key,
        filename,
        artifact: {inlineData: {data: pngData, mimeType: 'image/png'}},
      });

      const version = await service.getArtifactVersion({...key, filename});
      const versions = await service.listArtifactVersions({...key, filename});

      expect(version?.mimeType).toBe('image/png');
      expect(versions[0].mimeType).toBe('image/png');
    });

    it('reports text/plain for a text artifact', async () => {
      const service = new InMemoryArtifactService();
      const filename = 'notes.txt';

      await service.saveArtifact({
        ...key,
        filename,
        artifact: {text: 'hello world'},
      });

      const version = await service.getArtifactVersion({...key, filename});
      const versions = await service.listArtifactVersions({...key, filename});

      expect(version?.mimeType).toBe('text/plain');
      expect(versions[0].mimeType).toBe('text/plain');
    });

    it('reports the mime type of file data', async () => {
      const service = new InMemoryArtifactService();
      const filename = 'report.pdf';

      await service.saveArtifact({
        ...key,
        filename,
        artifact: {
          fileData: {
            fileUri: 'gs://bucket/report.pdf',
            mimeType: 'application/pdf',
          },
        },
      });

      const version = await service.getArtifactVersion({...key, filename});

      expect(version?.mimeType).toBe('application/pdf');
    });

    it('leaves the mime type undefined for inline data without one', async () => {
      const service = new InMemoryArtifactService();
      const filename = 'blob.bin';

      await service.saveArtifact({
        ...key,
        filename,
        artifact: {inlineData: {data: pngData}},
      });

      const version = await service.getArtifactVersion({...key, filename});

      expect(version?.mimeType).toBeUndefined();
    });

    it('prefers inline data over a stray fileData sibling', async () => {
      const service = new InMemoryArtifactService();
      const filename = 'both.png';

      await service.saveArtifact({
        ...key,
        filename,
        artifact: {
          inlineData: {data: pngData, mimeType: 'image/png'},
          fileData: {
            fileUri: 'gs://bucket/report.pdf',
            mimeType: 'application/pdf',
          },
        },
      });

      const version = await service.getArtifactVersion({...key, filename});

      expect(version?.mimeType).toBe('image/png');
    });

    it('prefers text over a stray fileData sibling', async () => {
      const service = new InMemoryArtifactService();
      const filename = 'both.txt';

      await service.saveArtifact({
        ...key,
        filename,
        artifact: {
          text: 'hello',
          fileData: {
            fileUri: 'https://example.com/a.png',
            mimeType: 'image/png',
          },
        },
      });

      const version = await service.getArtifactVersion({...key, filename});

      expect(version?.mimeType).toBe('text/plain');
    });

    it('records a mime type per version across mixed artifact shapes', async () => {
      const service = new InMemoryArtifactService();
      const filename = 'mixed.bin';
      const artifacts = [
        {text: 'first'},
        {inlineData: {data: pngData, mimeType: 'image/png'}},
        {text: 'third'},
        {inlineData: {data: pngData, mimeType: 'application/pdf'}},
      ];

      for (const artifact of artifacts) {
        await service.saveArtifact({...key, filename, artifact});
      }

      const versions = await service.listArtifactVersions({...key, filename});
      const latest = await service.getArtifactVersion({...key, filename});
      const second = await service.getArtifactVersion({
        ...key,
        filename,
        version: 1,
      });

      expect(versions.map((v) => v.mimeType)).toEqual([
        'text/plain',
        'image/png',
        'text/plain',
        'application/pdf',
      ]);
      expect(latest?.mimeType).toBe('application/pdf');
      expect(second?.mimeType).toBe('image/png');
    });
  });
});
