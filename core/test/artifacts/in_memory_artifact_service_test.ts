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

  describe('scope identifier validation', () => {
    it.each([
      {
        field: 'appName',
        appName: '../escape',
        userId: 'user',
        sessionId: 'session',
      },
      {
        field: 'userId',
        appName: 'app',
        userId: '../escape',
        sessionId: 'session',
      },
      {
        field: 'sessionId',
        appName: 'app',
        userId: 'user',
        sessionId: '../escape',
      },
    ])(
      'rejects a traversal $field on every operation',
      async ({field, ...scope}) => {
        const service = new InMemoryArtifactService();
        const message = `${field} '../escape' must not contain traversal segments.`;

        await expect(
          service.saveArtifact({
            ...scope,
            filename: 'report.txt',
            artifact: {text: 'hello'},
          }),
        ).rejects.toThrow(message);
        await expect(
          service.loadArtifact({...scope, filename: 'report.txt'}),
        ).rejects.toThrow(message);
        await expect(
          service.deleteArtifact({...scope, filename: 'report.txt'}),
        ).rejects.toThrow(message);
        await expect(service.listArtifactKeys(scope)).rejects.toThrow(message);
      },
    );

    it('keeps the sessionId out of a user-namespaced path', async () => {
      const service = new InMemoryArtifactService();
      const scope = {appName: 'app', userId: 'user', sessionId: '../escape'};

      await service.saveArtifact({
        ...scope,
        filename: 'user:report.txt',
        artifact: {text: 'user-scoped'},
      });
      const loaded = await service.loadArtifact({
        ...scope,
        filename: 'user:report.txt',
      });

      expect(loaded?.text).toBe('user-scoped');
    });
  });

  it('records no mime type for a stored reference', async () => {
    const service = new InMemoryArtifactService();
    const scope = {appName: 'app', userId: 'user', sessionId: 'session'};

    await service.saveArtifact({
      ...scope,
      filename: 'source.txt',
      artifact: {text: 'source content'},
    });
    await service.saveArtifact({
      ...scope,
      filename: 'ref.txt',
      artifact: {
        fileData: {
          fileUri:
            'artifact://apps/app/users/user/sessions/session/artifacts/source.txt/versions/0',
          mimeType: 'text/plain',
        },
      },
    });

    const metadata = await service.getArtifactVersion({
      ...scope,
      filename: 'ref.txt',
      version: 0,
    });

    expect(metadata?.mimeType).toBeUndefined();
  });
});
