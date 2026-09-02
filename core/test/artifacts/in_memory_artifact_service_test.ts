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
});

describe('InMemoryArtifactService user-namespace listing', () => {
  async function serviceWithTwoSessions(): Promise<InMemoryArtifactService> {
    const service = new InMemoryArtifactService();

    await service.saveArtifact({
      appName: 'app0',
      userId: 'user0',
      sessionId: 's0',
      filename: 'user:profile.txt',
      artifact: {text: 'profile'},
    });
    await service.saveArtifact({
      appName: 'app0',
      userId: 'user0',
      sessionId: 's0',
      filename: 'note.txt',
      artifact: {text: 'note-s0'},
    });
    await service.saveArtifact({
      appName: 'app0',
      userId: 'user0',
      sessionId: 's1',
      filename: 'other.txt',
      artifact: {text: 'other-s1'},
    });

    return service;
  }

  it('lists only the user namespace when the session is omitted', async () => {
    const service = await serviceWithTwoSessions();

    const keys = await service.listArtifactKeys({
      appName: 'app0',
      userId: 'user0',
    });

    expect(keys).toEqual(['user:profile.txt']);
  });

  it('returns an empty list for a user who owns nothing', async () => {
    const service = await serviceWithTwoSessions();

    const keys = await service.listArtifactKeys({
      appName: 'app0',
      userId: 'stranger',
    });

    expect(keys).toEqual([]);
  });

  it('still lists session and user artifacts when the session is given', async () => {
    const service = await serviceWithTwoSessions();

    const keys = await service.listArtifactKeys({
      appName: 'app0',
      userId: 'user0',
      sessionId: 's0',
    });

    expect(keys).toEqual(['note.txt', 'user:profile.txt']);
  });

  it('does not leak a session named undefined into the user namespace', async () => {
    const service = new InMemoryArtifactService();

    await service.saveArtifact({
      appName: 'app0',
      userId: 'user0',
      sessionId: 'undefined',
      filename: 'note.txt',
      artifact: {text: 'session-scoped'},
    });

    const keys = await service.listArtifactKeys({
      appName: 'app0',
      userId: 'user0',
    });

    expect(keys).toEqual([]);
  });

  it('treats an empty session id as a session, not as an omitted one', async () => {
    const service = new InMemoryArtifactService();

    await service.saveArtifact({
      appName: 'app0',
      userId: 'user0',
      sessionId: '',
      filename: 'note.txt',
      artifact: {text: 'note'},
    });

    const emptySessionKeys = await service.listArtifactKeys({
      appName: 'app0',
      userId: 'user0',
      sessionId: '',
    });
    const userOnlyKeys = await service.listArtifactKeys({
      appName: 'app0',
      userId: 'user0',
    });

    expect(emptySessionKeys).toEqual(['note.txt']);
    expect(userOnlyKeys).toEqual([]);
  });
});

describe('InMemoryArtifactService negative version index', () => {
  const key = {appName: 'app0', userId: 'user0', sessionId: 's0'};

  async function serviceWithFourVersions(): Promise<InMemoryArtifactService> {
    const service = new InMemoryArtifactService();

    for (const revision of ['v0', 'v1', 'v2', 'v3']) {
      await service.saveArtifact({
        ...key,
        filename: 'note.txt',
        artifact: {text: revision},
      });
    }

    return service;
  }

  it.each([
    {version: -1, text: 'v3'},
    {version: -2, text: 'v2'},
    {version: -4, text: 'v0'},
  ])('loads $version counting from the end', async ({version, text}) => {
    const service = await serviceWithFourVersions();

    const artifact = await service.loadArtifact({
      ...key,
      filename: 'note.txt',
      version,
    });

    expect(artifact?.text).toBe(text);
  });

  it.each([-5, 4])(
    'loads nothing for the out-of-range version %i',
    async (version) => {
      const service = await serviceWithFourVersions();

      const artifact = await service.loadArtifact({
        ...key,
        filename: 'note.txt',
        version,
      });

      expect(artifact).toBeUndefined();
    },
  );

  it('reports the metadata of a version counted from the end', async () => {
    const service = await serviceWithFourVersions();

    const newest = await service.getArtifactVersion({
      ...key,
      filename: 'note.txt',
      version: -1,
    });
    const oldest = await service.getArtifactVersion({
      ...key,
      filename: 'note.txt',
      version: -4,
    });

    expect(newest?.version).toBe(3);
    expect(oldest?.version).toBe(0);
  });

  it.each([-5, 4])(
    'reports no metadata for the out-of-range version %i',
    async (version) => {
      const service = await serviceWithFourVersions();

      const metadata = await service.getArtifactVersion({
        ...key,
        filename: 'note.txt',
        version,
      });

      expect(metadata).toBeUndefined();
    },
  );

  it('loads nothing for a negative version of an unsaved filename', async () => {
    const service = await serviceWithFourVersions();

    const artifact = await service.loadArtifact({
      ...key,
      filename: 'missing.txt',
      version: -1,
    });

    expect(artifact).toBeUndefined();
  });
});

describe('InMemoryArtifactService public artifacts store', () => {
  const sessionKey = {appName: 'app0', userId: 'user0', sessionId: 's0'};
  const sessionPath = 'session/app0/user0/s0/note.txt';

  it('starts empty and gains one key per saved filename', async () => {
    const service = new InMemoryArtifactService();

    expect(service.artifacts).toEqual({});

    await service.saveArtifact({
      ...sessionKey,
      filename: 'note.txt',
      artifact: {text: 'note'},
    });

    expect(Object.keys(service.artifacts)).toEqual([sessionPath]);
  });

  it('exposes the saved part and its recorded metadata', async () => {
    const service = new InMemoryArtifactService();

    await service.saveArtifact({
      ...sessionKey,
      filename: 'note.txt',
      artifact: {text: 'note'},
      customMetadata: {origin: 'test'},
    });

    const entry = service.artifacts[sessionPath][0];

    expect(entry.data).toEqual({text: 'note'});
    expect(entry.artifactVersion).toEqual({
      version: 0,
      customMetadata: {origin: 'test'},
    });
  });

  it('serves a version that a caller mutated in place', async () => {
    const service = new InMemoryArtifactService();

    await service.saveArtifact({
      ...sessionKey,
      filename: 'note.txt',
      artifact: {text: 'note'},
    });
    service.artifacts[sessionPath][0].data = {text: 'rewritten'};

    const artifact = await service.loadArtifact({
      ...sessionKey,
      filename: 'note.txt',
    });

    expect(artifact?.text).toBe('rewritten');
  });

  it('serves a version that a caller seeded directly', async () => {
    const service = new InMemoryArtifactService();

    service.artifacts['user/app0/user0/user%3Aprofile.txt'] = [
      {data: {text: 'seeded'}, artifactVersion: {version: 0}},
    ];

    const keys = await service.listArtifactKeys({
      appName: 'app0',
      userId: 'user0',
    });
    const artifact = await service.loadArtifact({
      ...sessionKey,
      filename: 'user:profile.txt',
    });

    expect(keys).toEqual(['user:profile.txt']);
    expect(artifact?.text).toBe('seeded');
  });
});
