/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AudioCacheManager,
  InMemoryArtifactService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  SessionArtifactService,
  createSession,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';
import {logger} from '../../src/utils/logger.js';

const APP_NAME = 'app';
const USER_ID = 'user';
const SESSION_ID = 'session-id';

/** Base64 for the bytes 0x01 0x02 and 0x03 0x04. */
const FIRST_CHUNK = 'AQI=';
const SECOND_CHUNK = 'AwQ=';
/** Base64 for 0x01 0x02 0x03 0x04, i.e. both chunks joined. */
const JOINED_CHUNKS = 'AQIDBA==';

function makeContext(
  artifactService?: SessionArtifactService,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'invocation-id',
    agent: new LlmAgent({name: 'agent', model: 'fake-model'}),
    session: createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    }),
    artifactService,
    pluginManager: new PluginManager(),
  });
}

function makeArtifactService(): SessionArtifactService {
  return new ScopedArtifactService(
    new InMemoryArtifactService(),
    APP_NAME,
    USER_ID,
    SESSION_ID,
  );
}

describe('AudioCacheManager.cacheAudio', () => {
  let manager: AudioCacheManager;

  beforeEach(() => {
    manager = new AudioCacheManager();
  });

  it('caches user audio under the user role', () => {
    const invocationContext = makeContext();
    const blob = {data: FIRST_CHUNK, mimeType: 'audio/pcm'};

    manager.cacheAudio(invocationContext, blob, 'input');

    expect(invocationContext.inputRealtimeCache).toHaveLength(1);
    expect(invocationContext.inputRealtimeCache?.[0].role).toBe('user');
    expect(invocationContext.inputRealtimeCache?.[0].data).toBe(blob);
    expect(typeof invocationContext.inputRealtimeCache?.[0].timestamp).toBe(
      'number',
    );
    expect(invocationContext.outputRealtimeCache).toBeUndefined();
  });

  it('caches model audio under the model role', () => {
    const invocationContext = makeContext();

    manager.cacheAudio(
      invocationContext,
      {data: FIRST_CHUNK, mimeType: 'audio/pcm'},
      'output',
    );

    expect(invocationContext.outputRealtimeCache).toHaveLength(1);
    expect(invocationContext.outputRealtimeCache?.[0].role).toBe('model');
    expect(invocationContext.inputRealtimeCache).toBeUndefined();
  });

  it('appends further chunks to the same cache', () => {
    const invocationContext = makeContext();

    manager.cacheAudio(invocationContext, {data: FIRST_CHUNK}, 'input');
    manager.cacheAudio(invocationContext, {data: SECOND_CHUNK}, 'input');

    expect(invocationContext.inputRealtimeCache).toHaveLength(2);
  });

  it('rejects a blob that carries no data', () => {
    const invocationContext = makeContext();

    expect(() =>
      manager.cacheAudio(invocationContext, {mimeType: 'audio/pcm'}, 'input'),
    ).toThrow('Audio blobs must contain byte data.');
    expect(invocationContext.inputRealtimeCache).toBeUndefined();
  });
});

describe('AudioCacheManager.flushCaches', () => {
  let manager: AudioCacheManager;

  beforeEach(() => {
    manager = new AudioCacheManager();
  });

  it('writes one artifact per cache and clears both', async () => {
    const artifactService = makeArtifactService();
    const invocationContext = makeContext(artifactService);
    manager.cacheAudio(
      invocationContext,
      {data: FIRST_CHUNK, mimeType: 'audio/pcm'},
      'input',
    );
    manager.cacheAudio(
      invocationContext,
      {data: SECOND_CHUNK, mimeType: 'audio/pcm'},
      'output',
    );

    const events = await manager.flushCaches(invocationContext);

    expect(events).toHaveLength(2);
    expect(events[0].author).toBe('user');
    expect(events[0].content?.role).toBe('user');
    // A model event is authored by the agent, not by the raw role.
    expect(events[1].author).toBe('agent');
    expect(events[1].content?.role).toBe('model');
    expect(invocationContext.inputRealtimeCache).toEqual([]);
    expect(invocationContext.outputRealtimeCache).toEqual([]);

    const keys = await artifactService.listArtifactKeys();
    expect(keys).toHaveLength(2);
    expect(keys.some((key) => key.includes('input_audio'))).toBe(true);
    expect(keys.some((key) => key.includes('output_audio'))).toBe(true);
  });

  it('joins a cache into one artifact under the reference format', async () => {
    const artifactService = makeArtifactService();
    const invocationContext = makeContext(artifactService);
    manager.cacheAudio(
      invocationContext,
      {data: FIRST_CHUNK, mimeType: 'audio/pcm'},
      'output',
    );
    manager.cacheAudio(
      invocationContext,
      {data: SECOND_CHUNK, mimeType: 'audio/pcm'},
      'output',
    );
    const timestampMs = Math.floor(
      invocationContext.outputRealtimeCache![0].timestamp * 1000,
    );

    const events = await manager.flushCaches(invocationContext);

    const filename = `adk_live_audio_storage_output_audio_${timestampMs}.pcm`;
    expect(events[0].content?.parts?.[0].fileData).toEqual({
      fileUri: `artifact://${APP_NAME}/${USER_ID}/${SESSION_ID}/_adk_live/${filename}#0`,
      mimeType: 'audio/pcm',
    });
    const saved = await artifactService.loadArtifact({filename});
    expect(saved?.inlineData?.data).toBe(JOINED_CHUNKS);
  });

  it('defaults the mime type when a chunk declares none', async () => {
    const artifactService = makeArtifactService();
    const invocationContext = makeContext(artifactService);
    manager.cacheAudio(invocationContext, {data: FIRST_CHUNK}, 'input');

    const events = await manager.flushCaches(invocationContext);

    expect(events[0].content?.parts?.[0].fileData?.mimeType).toBe('audio/pcm');
  });

  it('flushes only the cache the caller asked for', async () => {
    const invocationContext = makeContext(makeArtifactService());
    manager.cacheAudio(invocationContext, {data: FIRST_CHUNK}, 'input');
    manager.cacheAudio(invocationContext, {data: SECOND_CHUNK}, 'output');

    const events = await manager.flushCaches(invocationContext, {
      flushUserAudio: false,
    });

    expect(events).toHaveLength(1);
    expect(events[0].content?.role).toBe('model');
    expect(invocationContext.inputRealtimeCache).toHaveLength(1);
    expect(invocationContext.outputRealtimeCache).toEqual([]);
  });

  it('keeps the audio when there is no artifact service', async () => {
    const invocationContext = makeContext();
    manager.cacheAudio(invocationContext, {data: FIRST_CHUNK}, 'input');

    const events = await manager.flushCaches(invocationContext);

    expect(events).toEqual([]);
    expect(invocationContext.inputRealtimeCache).toHaveLength(1);
  });

  it('saves an empty artifact for a cache whose chunks carry no data', async () => {
    const artifactService = makeArtifactService();
    const invocationContext = makeContext(artifactService);
    invocationContext.outputRealtimeCache = [
      {role: 'model', data: {mimeType: 'audio/pcm'}, timestamp: 1},
    ];

    const events = await new AudioCacheManager().flushCaches(invocationContext);

    expect(events).toHaveLength(1);
    const filename = 'adk_live_audio_storage_output_audio_1000.pcm';
    const saved = await artifactService.loadArtifact({filename});
    expect(saved?.inlineData?.data).toBe('');
  });

  it('returns nothing when both caches are empty', async () => {
    const invocationContext = makeContext(makeArtifactService());

    expect(await manager.flushCaches(invocationContext)).toEqual([]);
  });

  it('keeps the audio and logs when the artifact save fails', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const artifactService = makeArtifactService();
    vi.spyOn(artifactService, 'saveArtifact').mockRejectedValue(
      new Error('artifact service unavailable'),
    );
    const invocationContext = makeContext(artifactService);
    manager.cacheAudio(invocationContext, {data: FIRST_CHUNK}, 'output');

    const events = await manager.flushCaches(invocationContext);

    expect(events).toEqual([]);
    expect(invocationContext.outputRealtimeCache).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      'Failed to flush the output_audio cache:',
      expect.any(Error),
    );
    error.mockRestore();
  });
});
