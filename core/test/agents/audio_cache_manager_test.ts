/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  SessionArtifactService,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

import {
  cacheAudio,
  flushAudioCaches,
} from '../../src/agents/audio_cache_manager.js';
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

describe('cacheAudio', () => {
  it('caches user audio under the user role', () => {
    const invocationContext = makeContext();
    const blob = {data: FIRST_CHUNK, mimeType: 'audio/pcm'};

    cacheAudio(invocationContext, blob, 'input');

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

    cacheAudio(
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

    cacheAudio(invocationContext, {data: FIRST_CHUNK}, 'input');
    cacheAudio(invocationContext, {data: SECOND_CHUNK}, 'input');

    expect(invocationContext.inputRealtimeCache).toHaveLength(2);
  });

  it('rejects a blob that carries no data', () => {
    const invocationContext = makeContext();

    expect(() =>
      cacheAudio(invocationContext, {mimeType: 'audio/pcm'}, 'input'),
    ).toThrow('Audio blobs must contain byte data.');
    expect(invocationContext.inputRealtimeCache).toBeUndefined();
  });
});

describe('flushAudioCaches', () => {
  it('writes one artifact per cache and clears both', async () => {
    const artifactService = makeArtifactService();
    const invocationContext = makeContext(artifactService);
    cacheAudio(
      invocationContext,
      {data: FIRST_CHUNK, mimeType: 'audio/pcm'},
      'input',
    );
    cacheAudio(
      invocationContext,
      {data: SECOND_CHUNK, mimeType: 'audio/pcm'},
      'output',
    );

    const events = await flushAudioCaches(invocationContext);

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
    cacheAudio(
      invocationContext,
      {data: FIRST_CHUNK, mimeType: 'audio/pcm'},
      'output',
    );
    cacheAudio(
      invocationContext,
      {data: SECOND_CHUNK, mimeType: 'audio/pcm'},
      'output',
    );
    const timestampMs = Math.floor(
      invocationContext.outputRealtimeCache![0].timestamp,
    );

    const events = await flushAudioCaches(invocationContext);

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
    cacheAudio(invocationContext, {data: FIRST_CHUNK}, 'input');

    const events = await flushAudioCaches(invocationContext);

    expect(events[0].content?.parts?.[0].fileData?.mimeType).toBe('audio/pcm');
  });

  it('flushes only the cache the caller asked for', async () => {
    const invocationContext = makeContext(makeArtifactService());
    cacheAudio(invocationContext, {data: FIRST_CHUNK}, 'input');
    cacheAudio(invocationContext, {data: SECOND_CHUNK}, 'output');

    const events = await flushAudioCaches(invocationContext, false);

    expect(events).toHaveLength(1);
    expect(events[0].content?.role).toBe('model');
    expect(invocationContext.inputRealtimeCache).toHaveLength(1);
    expect(invocationContext.outputRealtimeCache).toEqual([]);
  });

  it('keeps the audio when there is no artifact service', async () => {
    const invocationContext = makeContext();
    cacheAudio(invocationContext, {data: FIRST_CHUNK}, 'input');

    const events = await flushAudioCaches(invocationContext);

    expect(events).toEqual([]);
    expect(invocationContext.inputRealtimeCache).toHaveLength(1);
  });

  it('saves an empty artifact for a cache whose chunks carry no data', async () => {
    const artifactService = makeArtifactService();
    const invocationContext = makeContext(artifactService);
    invocationContext.outputRealtimeCache = [
      {role: 'model', data: {mimeType: 'audio/pcm'}, timestamp: 1},
    ];

    const events = await flushAudioCaches(invocationContext);

    expect(events).toHaveLength(1);
    const filename = 'adk_live_audio_storage_output_audio_1.pcm';
    const saved = await artifactService.loadArtifact({filename});
    expect(saved?.inlineData?.data).toBe('');
  });

  it('returns nothing when both caches are empty', async () => {
    const invocationContext = makeContext(makeArtifactService());

    expect(await flushAudioCaches(invocationContext)).toEqual([]);
  });

  it('timestamps the flushed event in epoch milliseconds', async () => {
    const invocationContext = makeContext(makeArtifactService());
    const before = Date.now();
    cacheAudio(invocationContext, {data: FIRST_CHUNK}, 'output');

    const events = await flushAudioCaches(invocationContext);

    // An event timestamped in seconds lands in 1970 and drags
    // `session.lastUpdateTime` back with it when the runner persists it.
    expect(events[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(events[0].timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('keeps the session current when the flushed event is appended', async () => {
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const invocationContext = makeContext(makeArtifactService());
    cacheAudio(invocationContext, {data: FIRST_CHUNK}, 'output');
    const events = await flushAudioCaches(invocationContext);
    const createdAt = session.lastUpdateTime;

    await sessionService.appendEvent({session, event: events[0]});

    expect(session.lastUpdateTime).toBeGreaterThanOrEqual(createdAt);
  });

  it('keeps the audio and logs when the artifact save fails', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const artifactService = makeArtifactService();
    vi.spyOn(artifactService, 'saveArtifact').mockRejectedValue(
      new Error('artifact service unavailable'),
    );
    const invocationContext = makeContext(artifactService);
    cacheAudio(invocationContext, {data: FIRST_CHUNK}, 'output');

    const events = await flushAudioCaches(invocationContext);

    expect(events).toEqual([]);
    expect(invocationContext.outputRealtimeCache).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      'Failed to flush the output_audio cache:',
      expect.any(Error),
    );
    error.mockRestore();
  });
});
