/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Blob} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {AudioCacheManager} from '../../src/agents/audio_cache_manager.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {InMemoryArtifactService} from '../../src/artifacts/in_memory_artifact_service.js';
import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';

const APP_NAME = 'test-app';
const USER_ID = 'test-user';
const SESSION_ID = 'test-session';
const AGENT_NAME = 'test-agent';

/** Base64 for the single byte 0x01, whose length is not a multiple of three. */
const ONE_BYTE = Buffer.from([1]).toString('base64');
/** Base64 for the two bytes 0x02 0x03. */
const TWO_BYTES = Buffer.from([2, 3]).toString('base64');

function makeContext(
  artifactService?: InMemoryArtifactService,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: AGENT_NAME}),
    session: createSession({
      id: SESSION_ID,
      appName: APP_NAME,
      userId: USER_ID,
    }),
    pluginManager: new PluginManager(),
    artifactService: artifactService
      ? new ScopedArtifactService(
          artifactService,
          APP_NAME,
          USER_ID,
          SESSION_ID,
        )
      : undefined,
  });
}

function audioBlob(data: string, mimeType = 'audio/pcm'): Blob {
  return {data, mimeType};
}

describe('AudioCacheManager.cacheAudio', () => {
  let manager: AudioCacheManager;
  let ctx: InvocationContext;

  beforeEach(() => {
    manager = new AudioCacheManager();
    ctx = makeContext(new InMemoryArtifactService());
  });

  it('caches input audio as the user role', () => {
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'input');

    expect(ctx.inputRealtimeCache).toHaveLength(1);
    const entry = ctx.inputRealtimeCache?.[0];
    expect(entry?.role).toBe('user');
    expect(entry?.data).toEqual({data: ONE_BYTE, mimeType: 'audio/pcm'});
    expect(typeof entry?.timestamp).toBe('number');
    expect(ctx.outputRealtimeCache).toBeUndefined();
  });

  it('caches output audio as the model role', () => {
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'output');

    expect(ctx.outputRealtimeCache).toHaveLength(1);
    expect(ctx.outputRealtimeCache?.[0].role).toBe('model');
    expect(ctx.inputRealtimeCache).toBeUndefined();
  });

  it('rejects a blob that carries no data and leaves the cache untouched', () => {
    expect(() =>
      manager.cacheAudio(ctx, {mimeType: 'audio/pcm'}, 'input'),
    ).toThrow('Audio blobs must contain data.');

    expect(ctx.inputRealtimeCache).toBeUndefined();
  });

  it('accumulates several chunks per direction in arrival order', () => {
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'input');
    manager.cacheAudio(ctx, audioBlob(TWO_BYTES), 'input');
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'input');
    manager.cacheAudio(ctx, audioBlob(TWO_BYTES), 'output');
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'output');

    expect(ctx.inputRealtimeCache?.map((e) => e.data.data)).toEqual([
      ONE_BYTE,
      TWO_BYTES,
      ONE_BYTE,
    ]);
    expect(ctx.outputRealtimeCache?.map((e) => e.data.data)).toEqual([
      TWO_BYTES,
      ONE_BYTE,
    ]);
  });

  it('drops the oldest chunks once the cap is reached', () => {
    // Three bytes per chunk, so only two chunks fit under a 7-byte cap.
    const chunk = (byte: number) =>
      audioBlob(Buffer.from([byte, byte, byte]).toString('base64'));
    const capped = new AudioCacheManager(7);

    capped.cacheAudio(ctx, chunk(1), 'input');
    capped.cacheAudio(ctx, chunk(2), 'input');
    capped.cacheAudio(ctx, chunk(3), 'input');

    expect(ctx.inputRealtimeCache?.map((e) => e.data.data)).toEqual([
      chunk(2).data,
      chunk(3).data,
    ]);
  });

  it('counts a chunk seeded without data as empty when measuring the cache', () => {
    const capped = new AudioCacheManager(2);
    ctx.inputRealtimeCache = [
      {role: 'user', data: {mimeType: 'audio/pcm'}, timestamp: 1},
    ];

    capped.cacheAudio(ctx, audioBlob(TWO_BYTES), 'input');

    // The data-less chunk weighs nothing, so the new chunk fits beside it.
    expect(ctx.inputRealtimeCache).toHaveLength(2);
  });

  it('keeps a single chunk that is larger than the cap on its own', () => {
    const capped = new AudioCacheManager(1);

    capped.cacheAudio(ctx, audioBlob(TWO_BYTES), 'input');

    expect(ctx.inputRealtimeCache).toHaveLength(1);
    expect(ctx.inputRealtimeCache?.[0].data.data).toBe(TWO_BYTES);
  });
});

describe('AudioCacheManager.flushCaches', () => {
  let manager: AudioCacheManager;
  let artifactService: InMemoryArtifactService;
  let ctx: InvocationContext;

  beforeEach(() => {
    manager = new AudioCacheManager();
    artifactService = new InMemoryArtifactService();
    ctx = makeContext(artifactService);
  });

  it('flushes both directions and clears both caches', async () => {
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'input');
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'output');

    const events = await manager.flushCaches(ctx);

    expect(events).toHaveLength(2);
    expect(ctx.inputRealtimeCache).toHaveLength(0);
    expect(ctx.outputRealtimeCache).toHaveLength(0);
    const keys = await artifactService.listArtifactKeys({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(keys).toHaveLength(2);
  });

  it('empties the caches a cloned context shares with the original', async () => {
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'input');
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'output');
    const subAgentCtx = ctx.clone();

    await manager.flushCaches(subAgentCtx);

    expect(ctx.inputRealtimeCache).toHaveLength(0);
    expect(ctx.outputRealtimeCache).toHaveLength(0);
  });

  it('flushes only the direction the caller asked for', async () => {
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'input');
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'output');

    const events = await manager.flushCaches(ctx, {flushUserAudio: false});

    expect(events).toHaveLength(1);
    expect(ctx.inputRealtimeCache).toHaveLength(1);
    expect(ctx.outputRealtimeCache).toHaveLength(0);
    const keys = await artifactService.listArtifactKeys({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(keys).toEqual([
      expect.stringContaining('adk_live_audio_storage_output_audio_'),
    ]);
  });

  it('writes nothing when both caches are empty', async () => {
    const saveArtifact = vi.spyOn(artifactService, 'saveArtifact');

    expect(await manager.flushCaches(ctx)).toEqual([]);

    expect(saveArtifact).not.toHaveBeenCalled();
  });

  it('keeps the cache when no artifact service is configured', async () => {
    const serviceless = makeContext();
    manager.cacheAudio(serviceless, audioBlob(ONE_BYTE), 'input');

    expect(await manager.flushCaches(serviceless)).toEqual([]);

    expect(serviceless.inputRealtimeCache).toHaveLength(1);
  });

  it('keeps the cache when the artifact service rejects', async () => {
    vi.spyOn(artifactService, 'saveArtifact').mockRejectedValue(
      new Error('artifact store is down'),
    );
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'input');

    expect(await manager.flushCaches(ctx)).toEqual([]);

    expect(ctx.inputRealtimeCache).toHaveLength(1);
  });

  it('stores the concatenated decoded bytes, not the concatenated base64', async () => {
    ctx.inputRealtimeCache = [
      {role: 'user', data: audioBlob(ONE_BYTE), timestamp: 1},
      {role: 'user', data: audioBlob(TWO_BYTES), timestamp: 2},
    ];

    await manager.flushCaches(ctx);

    const artifact = await artifactService.loadArtifact({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      filename: 'adk_live_audio_storage_input_audio_1.pcm',
    });
    expect(artifact?.inlineData?.mimeType).toBe('audio/pcm');
    expect(
      Array.from(Buffer.from(artifact?.inlineData?.data ?? '', 'base64')),
    ).toEqual([1, 2, 3]);
  });

  it('skips a chunk seeded without data when combining the audio', async () => {
    ctx.inputRealtimeCache = [
      {role: 'user', data: audioBlob(ONE_BYTE), timestamp: 1},
      {role: 'user', data: {mimeType: 'audio/pcm'}, timestamp: 2},
      {role: 'user', data: audioBlob(TWO_BYTES), timestamp: 3},
    ];

    await manager.flushCaches(ctx);

    const artifact = await artifactService.loadArtifact({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      filename: 'adk_live_audio_storage_input_audio_1.pcm',
    });
    expect(
      Array.from(Buffer.from(artifact?.inlineData?.data ?? '', 'base64')),
    ).toEqual([1, 2, 3]);
  });

  it('names the artifact after the first chunk, not the flush time', async () => {
    ctx.inputRealtimeCache = [
      {role: 'user', data: audioBlob(ONE_BYTE), timestamp: 1717171717171},
      {role: 'user', data: audioBlob(TWO_BYTES), timestamp: 1717171717999},
    ];

    await manager.flushCaches(ctx);

    const keys = await artifactService.listArtifactKeys({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    expect(keys).toEqual([
      'adk_live_audio_storage_input_audio_1717171717171.pcm',
    ]);
  });

  it('authors the user event as the user and stamps the first timestamp', async () => {
    ctx.inputRealtimeCache = [
      {role: 'user', data: audioBlob(ONE_BYTE), timestamp: 4242},
    ];

    const [event] = await manager.flushCaches(ctx);

    expect(event.author).toBe('user');
    expect(event.content?.role).toBe('user');
    expect(event.timestamp).toBe(4242);
    expect(event.invocationId).toBe('inv-1');
  });

  it('authors the model event as the agent rather than the literal model role', async () => {
    ctx.outputRealtimeCache = [
      {role: 'model', data: audioBlob(ONE_BYTE), timestamp: 99},
    ];

    const [event] = await manager.flushCaches(ctx);

    expect(event.author).toBe(AGENT_NAME);
    expect(event.content?.role).toBe('model');
  });

  it('references the artifact by uri and carries no inline data', async () => {
    ctx.outputRealtimeCache = [
      {role: 'model', data: audioBlob(ONE_BYTE), timestamp: 7},
    ];

    const [event] = await manager.flushCaches(ctx);

    const parts = event.content?.parts;
    expect(parts).toHaveLength(1);
    expect(parts?.[0].inlineData).toBeUndefined();
    expect(parts?.[0].fileData).toEqual({
      fileUri: `artifact://${APP_NAME}/${USER_ID}/${SESSION_ID}/_adk_live/adk_live_audio_storage_output_audio_7.pcm#0`,
      mimeType: 'audio/pcm',
    });
  });

  it('cuts mime parameters out of the filename extension', async () => {
    ctx.inputRealtimeCache = [
      {
        role: 'user',
        data: audioBlob(ONE_BYTE, 'audio/pcm;rate=24000'),
        timestamp: 5,
      },
    ];

    const [event] = await manager.flushCaches(ctx);

    const fileUri = event.content?.parts?.[0].fileData?.fileUri ?? '';
    expect(fileUri).toContain('adk_live_audio_storage_input_audio_5.pcm#0');
    expect(fileUri).not.toContain(';');
    expect(fileUri).not.toContain('=');
  });

  it('falls back to audio/pcm when the chunk declares no mime type', async () => {
    ctx.inputRealtimeCache = [
      {role: 'user', data: {data: ONE_BYTE}, timestamp: 6},
    ];

    const [event] = await manager.flushCaches(ctx);

    expect(event.content?.parts?.[0].fileData).toEqual({
      fileUri: `artifact://${APP_NAME}/${USER_ID}/${SESSION_ID}/_adk_live/adk_live_audio_storage_input_audio_6.pcm#0`,
      mimeType: 'audio/pcm',
    });
  });

  it('uses a mime type without a slash as the extension', async () => {
    ctx.inputRealtimeCache = [
      {role: 'user', data: audioBlob(ONE_BYTE, 'audio'), timestamp: 8},
    ];

    const [event] = await manager.flushCaches(ctx);

    expect(event.content?.parts?.[0].fileData?.fileUri).toContain(
      'adk_live_audio_storage_input_audio_8.audio#0',
    );
  });

  it('falls back to a bin extension when the mime subtype sanitizes to nothing', async () => {
    ctx.inputRealtimeCache = [
      {role: 'user', data: audioBlob(ONE_BYTE, 'audio/'), timestamp: 9},
    ];

    const [event] = await manager.flushCaches(ctx);

    expect(event.content?.parts?.[0].fileData?.fileUri).toContain(
      'adk_live_audio_storage_input_audio_9.bin#0',
    );
  });
});

describe('AudioCacheManager.handleControlEventFlush', () => {
  let manager: AudioCacheManager;
  let artifactService: InMemoryArtifactService;
  let ctx: InvocationContext;

  beforeEach(() => {
    manager = new AudioCacheManager();
    artifactService = new InMemoryArtifactService();
    ctx = makeContext(artifactService);
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'input');
    manager.cacheAudio(ctx, audioBlob(ONE_BYTE), 'output');
  });

  it('flushes the model audio only on an interruption', async () => {
    const events = await manager.handleControlEventFlush(ctx, {
      interrupted: true,
    });

    expect(events.map((e) => e.author)).toEqual([AGENT_NAME]);
    expect(ctx.inputRealtimeCache).toHaveLength(1);
    expect(ctx.outputRealtimeCache).toHaveLength(0);
  });

  it('flushes both directions on a completed turn', async () => {
    const events = await manager.handleControlEventFlush(ctx, {
      turnComplete: true,
    });

    expect(events.map((e) => e.author)).toEqual(['user', AGENT_NAME]);
    expect(ctx.inputRealtimeCache).toHaveLength(0);
    expect(ctx.outputRealtimeCache).toHaveLength(0);
  });

  it('treats an interrupted and completed turn as an interruption', async () => {
    const events = await manager.handleControlEventFlush(ctx, {
      interrupted: true,
      turnComplete: true,
    });

    expect(events.map((e) => e.author)).toEqual([AGENT_NAME]);
    expect(ctx.inputRealtimeCache).toHaveLength(1);
  });

  it('flushes nothing for a response that ends no turn', async () => {
    const saveArtifact = vi.spyOn(artifactService, 'saveArtifact');

    expect(await manager.handleControlEventFlush(ctx, {})).toEqual([]);

    expect(saveArtifact).not.toHaveBeenCalled();
    expect(ctx.inputRealtimeCache).toHaveLength(1);
    expect(ctx.outputRealtimeCache).toHaveLength(1);
  });
});
