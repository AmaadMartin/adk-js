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

  describe('canonicalUri', () => {
    const appName = 'test-app';
    const userId = 'test-user';
    const sessionId = 'test-session';

    const saveAndReadUri = async (
      service: InMemoryArtifactService,
      filename: string,
    ): Promise<string> => {
      const version = await service.saveArtifact({
        appName,
        userId,
        sessionId,
        filename,
        artifact: {text: 'content'},
      });
      const metadata = await service.getArtifactVersion({
        appName,
        userId,
        sessionId,
        filename,
        version,
      });
      if (!metadata) {
        expect.fail('Expected the saved version to report its metadata.');
      }
      return metadata.canonicalUri;
    };

    it('addresses a session-scoped artifact through its session', async () => {
      const service = new InMemoryArtifactService();

      const uri = await saveAndReadUri(service, 'f.txt');

      expect(uri).toBe(
        'memory://apps/test-app/users/test-user/sessions/test-session/artifacts/f.txt/versions/0',
      );
    });

    it('leaves the session out of a user-scoped artifact', async () => {
      const service = new InMemoryArtifactService();

      const uri = await saveAndReadUri(service, 'user:f.txt');

      expect(uri).toBe(
        'memory://apps/test-app/users/test-user/artifacts/user:f.txt/versions/0',
      );
    });

    it('advances the version segment on each save', async () => {
      const service = new InMemoryArtifactService();

      await saveAndReadUri(service, 'f.txt');
      const uri = await saveAndReadUri(service, 'f.txt');

      expect(uri).toBe(
        'memory://apps/test-app/users/test-user/sessions/test-session/artifacts/f.txt/versions/1',
      );
    });
  });
});
