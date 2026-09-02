/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryArtifactService, InputValidationError} from '@google/adk';
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

  describe('session-less listArtifactKeys', () => {
    it('returns only the user namespace', async () => {
      const service = new InMemoryArtifactService();

      await service.saveArtifact({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'user:notes.txt',
        artifact: {text: 'user-scoped'},
      });
      await service.saveArtifact({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'session.txt',
        artifact: {text: 'session-scoped'},
      });

      const keys = await service.listArtifactKeys({
        appName: 'app',
        userId: 'user',
      });

      expect(keys).toEqual(['user:notes.txt']);
    });

    it('preserves the user prefix and sorts the keys', async () => {
      const service = new InMemoryArtifactService();

      await service.saveArtifact({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'user:b.txt',
        artifact: {text: 'b'},
      });
      await service.saveArtifact({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'user:a.txt',
        artifact: {text: 'a'},
      });

      const keys = await service.listArtifactKeys({
        appName: 'app',
        userId: 'user',
      });

      expect(keys).toEqual(['user:a.txt', 'user:b.txt']);
    });

    it('does not leak a session named undefined', async () => {
      const service = new InMemoryArtifactService();

      await service.saveArtifact({
        appName: 'app',
        userId: 'user',
        sessionId: 'undefined',
        filename: 'session.txt',
        artifact: {text: 'session-scoped'},
      });
      await service.saveArtifact({
        appName: 'app',
        userId: 'user',
        sessionId: 'undefined',
        filename: 'user:notes.txt',
        artifact: {text: 'user-scoped'},
      });

      const keys = await service.listArtifactKeys({
        appName: 'app',
        userId: 'user',
      });

      expect(keys).toEqual(['user:notes.txt']);
    });

    it('still returns both namespaces when a session is named', async () => {
      const service = new InMemoryArtifactService();

      await service.saveArtifact({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'user:notes.txt',
        artifact: {text: 'user-scoped'},
      });
      await service.saveArtifact({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
        filename: 'session.txt',
        artifact: {text: 'session-scoped'},
      });

      const keys = await service.listArtifactKeys({
        appName: 'app',
        userId: 'user',
        sessionId: 'session',
      });

      expect(keys).toEqual(['session.txt', 'user:notes.txt']);
    });
  });

  describe('negative version index', () => {
    const key = {
      appName: 'app',
      userId: 'user',
      sessionId: 'session',
      filename: 'report.txt',
    };

    async function saveThreeVersions(): Promise<InMemoryArtifactService> {
      const service = new InMemoryArtifactService();
      for (const text of ['v0', 'v1', 'v2']) {
        await service.saveArtifact({...key, artifact: {text}});
      }
      return service;
    }

    it('loads the newest version for -1', async () => {
      const service = await saveThreeVersions();

      const newest = await service.loadArtifact({...key, version: -1});
      const omitted = await service.loadArtifact(key);

      expect(newest?.text).toBe('v2');
      expect(omitted?.text).toBe('v2');
    });

    it('loads the version before newest for -2', async () => {
      const service = await saveThreeVersions();

      const artifact = await service.loadArtifact({...key, version: -2});

      expect(artifact?.text).toBe('v1');
    });

    it('resolves an out-of-range negative version to undefined', async () => {
      const service = await saveThreeVersions();

      const artifact = await service.loadArtifact({...key, version: -4});
      const version = await service.getArtifactVersion({...key, version: -4});

      expect(artifact).toBeUndefined();
      expect(version).toBeUndefined();
    });

    it('returns the newest version record for -1', async () => {
      const service = await saveThreeVersions();

      const version = await service.getArtifactVersion({...key, version: -1});

      expect(version?.version).toBe(2);
    });

    it('returns undefined for a positive out-of-range version', async () => {
      const service = await saveThreeVersions();

      const artifact = await service.loadArtifact({...key, version: 3});
      const version = await service.getArtifactVersion({...key, version: 3});

      expect(artifact).toBeUndefined();
      expect(version).toBeUndefined();
    });
  });

  describe('customMetadata', () => {
    const key = {
      appName: 'app',
      userId: 'user',
      sessionId: 'session',
      filename: 'report.txt',
    };

    it('is absent when the caller supplies none', async () => {
      const service = new InMemoryArtifactService();
      await service.saveArtifact({...key, artifact: {text: 'v0'}});

      const version = await service.getArtifactVersion(key);

      expect(version).toBeDefined();
      expect('customMetadata' in version!).toBe(false);
    });

    it('is absent when the caller supplies an empty object', async () => {
      const service = new InMemoryArtifactService();
      const supplied: Record<string, unknown> = {};
      await service.saveArtifact({
        ...key,
        artifact: {text: 'v0'},
        customMetadata: supplied,
      });

      supplied.injected = 'after the save';
      const version = await service.getArtifactVersion(key);

      expect(version).toBeDefined();
      expect('customMetadata' in version!).toBe(false);
    });

    it('is preserved unchanged when the caller supplies one', async () => {
      const service = new InMemoryArtifactService();
      await service.saveArtifact({
        ...key,
        artifact: {text: 'v0'},
        customMetadata: {origin: 'test'},
      });

      const version = await service.getArtifactVersion(key);

      expect(version?.customMetadata).toEqual({origin: 'test'});
    });
  });

  it('rejects an artifact that carries no payload', async () => {
    const service = new InMemoryArtifactService();

    const saved = service.saveArtifact({
      appName: 'app',
      userId: 'user',
      sessionId: 'session',
      filename: 'report.txt',
      artifact: {},
    });

    await expect(saved).rejects.toThrow(InputValidationError);
    await expect(saved).rejects.toThrow(
      'Artifact must have inlineData, text, or fileData content.',
    );
  });
});
