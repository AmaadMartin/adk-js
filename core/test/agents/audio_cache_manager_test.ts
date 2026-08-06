/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AudioCacheManager,
  BaseSessionService,
  createAudioCacheConfig,
  createSession,
  DEFAULT_AUTO_FLUSH_THRESHOLD,
  DEFAULT_MAX_CACHE_DURATION_SECONDS,
  DEFAULT_MAX_CACHE_SIZE_BYTES,
  Event,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RealtimeCacheEntry,
  SessionArtifactService,
} from '@google/adk';
import {Blob} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

const APP_NAME = 'test-app';
const USER_ID = 'test-user';
const SESSION_ID = 'test-session';
const INVOCATION_ID = 'inv_123';

/** Builds an audio `Blob` whose `data` is the base64 encoding of `text`. */
function pcmBlob(text: string, mimeType = 'audio/pcm'): Blob {
  return {data: Buffer.from(text).toString('base64'), mimeType};
}

/** Creates a fully-stubbed {@link SessionArtifactService}. */
function makeArtifactServiceStub(revision = 0): SessionArtifactService {
  return {
    saveArtifact: vi.fn().mockResolvedValue(revision),
    loadArtifact: vi.fn(),
    listArtifactKeys: vi.fn(),
    deleteArtifact: vi.fn(),
    listVersions: vi.fn(),
    listArtifactVersions: vi.fn(),
    getArtifactVersion: vi.fn(),
  };
}

/** Builds a real {@link InvocationContext} for the manager under test. */
function createContext(
  opts: {
    agentName?: string;
    artifactService?: SessionArtifactService;
    sessionService?: BaseSessionService;
  } = {},
): InvocationContext {
  const agent = new LlmAgent({name: opts.agentName ?? 'test_agent'});
  const session = createSession({
    id: SESSION_ID,
    appName: APP_NAME,
    userId: USER_ID,
  });
  return new InvocationContext({
    invocationId: INVOCATION_ID,
    session,
    agent,
    pluginManager: new PluginManager(),
    artifactService: opts.artifactService,
    sessionService: opts.sessionService,
  });
}

describe('createAudioCacheConfig', () => {
  it('applies default values', () => {
    const config = createAudioCacheConfig();
    expect(config.maxCacheSizeBytes).toBe(DEFAULT_MAX_CACHE_SIZE_BYTES);
    expect(config.maxCacheSizeBytes).toBe(10 * 1024 * 1024);
    expect(config.maxCacheDurationSeconds).toBe(
      DEFAULT_MAX_CACHE_DURATION_SECONDS,
    );
    expect(config.maxCacheDurationSeconds).toBe(300);
    expect(config.autoFlushThreshold).toBe(DEFAULT_AUTO_FLUSH_THRESHOLD);
    expect(config.autoFlushThreshold).toBe(100);
  });

  it('applies custom overrides', () => {
    const config = createAudioCacheConfig({
      maxCacheSizeBytes: 5 * 1024 * 1024,
      maxCacheDurationSeconds: 120,
      autoFlushThreshold: 50,
    });
    expect(config.maxCacheSizeBytes).toBe(5 * 1024 * 1024);
    expect(config.maxCacheDurationSeconds).toBe(120);
    expect(config.autoFlushThreshold).toBe(50);
  });
});

describe('AudioCacheManager.cacheAudio', () => {
  it("caches input audio with role 'user'", () => {
    const manager = new AudioCacheManager();
    const ctx = createContext();
    const blob = pcmBlob('test_audio_data');

    expect(ctx.inputRealtimeCache).toBeUndefined();

    manager.cacheAudio(ctx, blob, 'input');

    expect(ctx.inputRealtimeCache).toHaveLength(1);
    const entry = ctx.inputRealtimeCache![0];
    expect(entry.role).toBe('user');
    expect(entry.data).toBe(blob);
    expect(typeof entry.timestamp).toBe('number');
  });

  it("caches output audio with role 'model'", () => {
    const manager = new AudioCacheManager();
    const ctx = createContext();
    const blob = pcmBlob('test_model_audio', 'audio/wav');

    expect(ctx.outputRealtimeCache).toBeUndefined();

    manager.cacheAudio(ctx, blob, 'output');

    expect(ctx.outputRealtimeCache).toHaveLength(1);
    const entry = ctx.outputRealtimeCache![0];
    expect(entry.role).toBe('model');
    expect(entry.data).toBe(blob);
    expect(typeof entry.timestamp).toBe('number');
  });

  it('appends multiple chunks to each cache', () => {
    const manager = new AudioCacheManager();
    const ctx = createContext();

    for (let i = 0; i < 3; i++) {
      manager.cacheAudio(ctx, pcmBlob(`input_${i}`), 'input');
    }
    for (let i = 0; i < 2; i++) {
      manager.cacheAudio(ctx, pcmBlob(`output_${i}`, 'audio/wav'), 'output');
    }

    expect(ctx.inputRealtimeCache).toHaveLength(3);
    expect(ctx.outputRealtimeCache).toHaveLength(2);
  });

  it('throws on an invalid cacheType', () => {
    const manager = new AudioCacheManager();
    const ctx = createContext();

    expect(() =>
      manager.cacheAudio(
        ctx,
        pcmBlob('x'),
        'invalid' as unknown as 'input' | 'output',
      ),
    ).toThrow("cacheType must be either 'input' or 'output'");
  });
});

describe('AudioCacheManager.flushCaches', () => {
  it('flushes both caches and clears them', async () => {
    const artifactService = makeArtifactServiceStub(123);
    const manager = new AudioCacheManager();
    const ctx = createContext({artifactService});

    manager.cacheAudio(ctx, pcmBlob('input_data'), 'input');
    manager.cacheAudio(ctx, pcmBlob('output_data', 'audio/wav'), 'output');

    const events = await manager.flushCaches(ctx);

    expect(ctx.inputRealtimeCache).toEqual([]);
    expect(ctx.outputRealtimeCache).toEqual([]);
    expect(artifactService.saveArtifact).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(2);
  });

  it('selectively flushes only the input cache', async () => {
    const artifactService = makeArtifactServiceStub(123);
    const manager = new AudioCacheManager();
    const ctx = createContext({artifactService});

    manager.cacheAudio(ctx, pcmBlob('input_data'), 'input');
    manager.cacheAudio(ctx, pcmBlob('output_data', 'audio/wav'), 'output');

    const events = await manager.flushCaches(ctx, {
      flushUserAudio: true,
      flushModelAudio: false,
    });

    expect(ctx.inputRealtimeCache).toEqual([]);
    expect(ctx.outputRealtimeCache).toHaveLength(1);
    expect(artifactService.saveArtifact).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });

  it('is a no-op when both caches are empty', async () => {
    const artifactService = makeArtifactServiceStub();
    const manager = new AudioCacheManager();
    const ctx = createContext({artifactService});

    const events = await manager.flushCaches(ctx);

    expect(artifactService.saveArtifact).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('retains caches when no artifact service is available', async () => {
    const manager = new AudioCacheManager();
    const ctx = createContext();

    manager.cacheAudio(ctx, pcmBlob('input_data'), 'input');
    manager.cacheAudio(ctx, pcmBlob('output_data', 'audio/wav'), 'output');

    const events = await manager.flushCaches(ctx);

    expect(ctx.inputRealtimeCache).toHaveLength(1);
    expect(ctx.outputRealtimeCache).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('saves the combined artifact and never writes to the session', async () => {
    const artifactService = makeArtifactServiceStub(456);
    const sessionService = {
      appendEvent: vi.fn(),
    } as unknown as BaseSessionService;
    const manager = new AudioCacheManager();
    const ctx = createContext({artifactService, sessionService});

    const blob = pcmBlob('specific_test_audio_data');
    manager.cacheAudio(ctx, blob, 'input');

    await manager.flushCaches(ctx);

    expect(artifactService.saveArtifact).toHaveBeenCalledTimes(1);
    const request = vi.mocked(artifactService.saveArtifact).mock.calls[0][0];
    expect(request.artifact.inlineData?.data).toBe(blob.data);
    expect(request.artifact.inlineData?.mimeType).toBe('audio/pcm');
    expect(sessionService.appendEvent).not.toHaveBeenCalled();
  });

  it('uses the first chunk timestamp for the filename', async () => {
    const artifactService = makeArtifactServiceStub(789);
    const manager = new AudioCacheManager();
    const ctx = createContext({artifactService});

    const firstTs = 1234567890123;
    const secondTs = 1234567891456;
    ctx.inputRealtimeCache = [
      {role: 'user', data: pcmBlob('first_chunk'), timestamp: firstTs},
      {role: 'user', data: pcmBlob('second_chunk'), timestamp: secondTs},
    ];

    await manager.flushCaches(ctx);

    const request = vi.mocked(artifactService.saveArtifact).mock.calls[0][0];
    expect(request.filename).toBe(
      `adk_live_audio_storage_input_audio_${firstTs}.pcm`,
    );
  });

  it("sets user-audio event author and role to 'user'", async () => {
    const artifactService = makeArtifactServiceStub(123);
    const manager = new AudioCacheManager();
    const ctx = createContext({artifactService});

    manager.cacheAudio(ctx, pcmBlob('user_audio_data'), 'input');

    const events = await manager.flushCaches(ctx, {
      flushUserAudio: true,
      flushModelAudio: false,
    });

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('user');
    expect(events[0].content?.role).toBe('user');
    const fileData = events[0].content?.parts?.[0].fileData;
    expect(fileData?.fileUri).toBe(
      `artifact://${APP_NAME}/${USER_ID}/${SESSION_ID}/_adk_live/` +
        `${filenameFromEvent(events[0])}#123`,
    );
    expect(fileData?.fileUri).toContain('/_adk_live/');
    expect(fileData?.mimeType).toBe('audio/pcm');
  });

  it("sets model-audio event author to the agent name, role stays 'model'", async () => {
    const artifactService = makeArtifactServiceStub(123);
    const manager = new AudioCacheManager();
    const ctx = createContext({agentName: 'my_test_agent', artifactService});

    manager.cacheAudio(ctx, pcmBlob('model_audio_data', 'audio/wav'), 'output');

    const events = await manager.flushCaches(ctx, {
      flushUserAudio: false,
      flushModelAudio: true,
    });

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('my_test_agent');
    expect(events[0].content?.role).toBe('model');
  });

  it('concatenates chunk bytes exactly (no base64 corruption)', async () => {
    const artifactService = makeArtifactServiceStub(7);
    const manager = new AudioCacheManager();
    const ctx = createContext({artifactService});

    const first = pcmBlob('chunk-one');
    const second = pcmBlob('chunk-two');
    manager.cacheAudio(ctx, first, 'input');
    manager.cacheAudio(ctx, second, 'input');

    const events = await manager.flushCaches(ctx, {flushModelAudio: false});

    const request = vi.mocked(artifactService.saveArtifact).mock.calls[0][0];
    const combined = Buffer.from(request.artifact.inlineData!.data!, 'base64');
    const expected = Buffer.concat([
      Buffer.from(first.data!, 'base64'),
      Buffer.from(second.data!, 'base64'),
    ]);
    expect(combined.equals(expected)).toBe(true);
    // The fileUri carries the exact revision returned by saveArtifact.
    expect(events[0].content?.parts?.[0].fileData?.fileUri).toContain('#7');
  });

  it("defaults the mime type to 'audio/pcm' when a chunk omits it", async () => {
    const artifactService = makeArtifactServiceStub(0);
    const manager = new AudioCacheManager();
    const ctx = createContext({artifactService});

    manager.cacheAudio(ctx, pcmBlob('audio', ''), 'input');

    const events = await manager.flushCaches(ctx, {flushModelAudio: false});

    const request = vi.mocked(artifactService.saveArtifact).mock.calls[0][0];
    expect(request.artifact.inlineData?.mimeType).toBe('audio/pcm');
    expect(request.filename.endsWith('.pcm')).toBe(true);
    expect(events[0].content?.parts?.[0].fileData?.mimeType).toBe('audio/pcm');
  });

  it('concatenates chunks whose data is undefined', async () => {
    const artifactService = makeArtifactServiceStub(0);
    const manager = new AudioCacheManager();
    const ctx = createContext({artifactService});

    ctx.inputRealtimeCache = [
      {role: 'user', data: {mimeType: 'audio/pcm'}, timestamp: 1},
    ];

    await manager.flushCaches(ctx, {flushModelAudio: false});

    const request = vi.mocked(artifactService.saveArtifact).mock.calls[0][0];
    expect(request.artifact.inlineData?.data).toBe('');
  });

  it('retains the cache and does not throw when saving fails', async () => {
    const artifactService = makeArtifactServiceStub();
    vi.mocked(artifactService.saveArtifact).mockRejectedValue(
      new Error('Artifact service error'),
    );
    const manager = new AudioCacheManager();
    const ctx = createContext({artifactService});

    manager.cacheAudio(ctx, pcmBlob('test_data'), 'input');

    const events = await manager.flushCaches(ctx);

    expect(events).toEqual([]);
    expect(ctx.inputRealtimeCache).toHaveLength(1);
  });

  it('is a no-op for an empty cache even with an artifact service', async () => {
    const artifactService = makeArtifactServiceStub(0);
    const manager = new AudioCacheManager(
      createAudioCacheConfig({autoFlushThreshold: 5}),
    );
    const ctx = createContext({artifactService});

    // Directly exercise the defensive empty-cache guard of the private helper.
    const flushCacheToServices = (
      manager as unknown as {
        flushCacheToServices: (
          ctx: InvocationContext,
          cache: RealtimeCacheEntry[],
          cacheType: string,
        ) => Promise<Event | undefined>;
      }
    ).flushCacheToServices.bind(manager);

    const event = await flushCacheToServices(ctx, [], 'input_audio');

    expect(event).toBeUndefined();
    expect(artifactService.saveArtifact).not.toHaveBeenCalled();
  });
});

describe('AudioCacheManager.getCacheStats', () => {
  it('returns zeros when both caches are undefined', () => {
    const manager = new AudioCacheManager();
    const ctx = {
      inputRealtimeCache: undefined,
      outputRealtimeCache: undefined,
    } as unknown as InvocationContext;

    expect(manager.getCacheStats(ctx)).toEqual({
      inputChunks: 0,
      outputChunks: 0,
      inputBytes: 0,
      outputBytes: 0,
      totalChunks: 0,
      totalBytes: 0,
    });
  });

  it('counts chunks and decoded bytes across both caches', () => {
    const manager = new AudioCacheManager();
    const ctx = createContext();

    manager.cacheAudio(ctx, pcmBlob('12345'), 'input'); // 5 bytes
    manager.cacheAudio(ctx, pcmBlob('1234567890'), 'input'); // 10 bytes
    manager.cacheAudio(ctx, pcmBlob('abc', 'audio/wav'), 'output'); // 3 bytes

    expect(manager.getCacheStats(ctx)).toEqual({
      inputChunks: 2,
      outputChunks: 1,
      inputBytes: 15,
      outputBytes: 3,
      totalChunks: 3,
      totalBytes: 18,
    });
  });

  it('tolerates chunks whose data is undefined', () => {
    const manager = new AudioCacheManager();
    const ctx = createContext();
    ctx.inputRealtimeCache = [
      {role: 'user', data: {mimeType: 'audio/pcm'}, timestamp: 1},
    ];

    expect(manager.getCacheStats(ctx).inputBytes).toBe(0);
  });
});

/** Extracts the artifact filename embedded in a flushed event's fileUri. */
function filenameFromEvent(event: Event): string {
  const fileUri = event.content?.parts?.[0].fileData?.fileUri ?? '';
  return fileUri.substring(fileUri.lastIndexOf('/') + 1, fileUri.indexOf('#'));
}
