/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/flows/llm_flows/test_audio_cache_manager.py` @ main.
 *
 * Every `it(...)` keeps its Python test name verbatim, so a reader can grep
 * the reference file for it. The reference's `TestAudioCacheConfig` class has
 * no counterpart here, because this port does not carry `AudioCacheConfig`:
 * nothing in either SDK reads its three fields.
 */

import {
  AudioCacheManager,
  InMemorySessionService,
  InputValidationError,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

import {
  RecordingArtifactService,
  createTestContext,
  toBase64,
} from './audio_cache_manager_test_utils.js';

describe('TestAudioCacheManager', () => {
  const manager = new AudioCacheManager();

  it('test_cache_input_audio', () => {
    const ctx = createTestContext();
    const audioBlob = {
      data: toBase64('test_audio_data'),
      mimeType: 'audio/pcm',
    };

    expect(ctx.inputRealtimeCache).toBeUndefined();

    manager.cacheAudio(ctx, audioBlob, 'input');

    expect(ctx.inputRealtimeCache).toHaveLength(1);
    const entry = ctx.inputRealtimeCache![0];
    expect(entry.role).toBe('user');
    expect(entry.data).toBe(audioBlob);
    expect(typeof entry.timestamp).toBe('number');
  });

  it('test_cache_audio_rejects_missing_byte_data', () => {
    const ctx = createTestContext();

    expect(() =>
      manager.cacheAudio(ctx, {mimeType: 'audio/pcm'}, 'input'),
    ).toThrowError(
      new InputValidationError('Audio blobs must contain byte data.'),
    );

    expect(ctx.inputRealtimeCache).toBeUndefined();
  });

  it('test_cache_output_audio', () => {
    const ctx = createTestContext();
    const audioBlob = {
      data: toBase64('test_model_audio'),
      mimeType: 'audio/wav',
    };

    expect(ctx.outputRealtimeCache).toBeUndefined();

    manager.cacheAudio(ctx, audioBlob, 'output');

    expect(ctx.outputRealtimeCache).toHaveLength(1);
    const entry = ctx.outputRealtimeCache![0];
    expect(entry.role).toBe('model');
    expect(entry.data).toBe(audioBlob);
    expect(typeof entry.timestamp).toBe('number');
  });

  it('test_multiple_audio_caching', () => {
    const ctx = createTestContext();

    for (let i = 0; i < 3; i++) {
      manager.cacheAudio(
        ctx,
        {data: toBase64(`input_${i}`), mimeType: 'audio/pcm'},
        'input',
      );
    }
    for (let i = 0; i < 2; i++) {
      manager.cacheAudio(
        ctx,
        {data: toBase64(`output_${i}`), mimeType: 'audio/wav'},
        'output',
      );
    }

    expect(ctx.inputRealtimeCache).toHaveLength(3);
    expect(ctx.outputRealtimeCache).toHaveLength(2);
  });

  it('test_flush_caches_both', async () => {
    const artifactService = new RecordingArtifactService();
    const ctx = createTestContext({artifactService});

    manager.cacheAudio(
      ctx,
      {data: toBase64('input_data'), mimeType: 'audio/pcm'},
      'input',
    );
    manager.cacheAudio(
      ctx,
      {data: toBase64('output_data'), mimeType: 'audio/wav'},
      'output',
    );

    await manager.flushCaches(ctx);

    expect(ctx.inputRealtimeCache).toEqual([]);
    expect(ctx.outputRealtimeCache).toEqual([]);
    expect(artifactService.saved).toHaveLength(2);
  });

  it('test_flush_caches_selective', async () => {
    const artifactService = new RecordingArtifactService();
    const ctx = createTestContext({artifactService});

    manager.cacheAudio(
      ctx,
      {data: toBase64('input_data'), mimeType: 'audio/pcm'},
      'input',
    );
    manager.cacheAudio(
      ctx,
      {data: toBase64('output_data'), mimeType: 'audio/wav'},
      'output',
    );

    await manager.flushCaches(ctx, {
      flushUserAudio: true,
      flushModelAudio: false,
    });

    expect(ctx.inputRealtimeCache).toEqual([]);
    expect(ctx.outputRealtimeCache).toHaveLength(1);
    expect(artifactService.saved).toHaveLength(1);
  });

  it('test_flush_empty_caches', async () => {
    const artifactService = new RecordingArtifactService();
    const ctx = createTestContext({artifactService});

    await expect(manager.flushCaches(ctx)).resolves.toEqual([]);

    expect(artifactService.saved).toHaveLength(0);
  });

  it('test_flush_without_artifact_service', async () => {
    const ctx = createTestContext();

    manager.cacheAudio(
      ctx,
      {data: toBase64('input_data'), mimeType: 'audio/pcm'},
      'input',
    );

    await expect(manager.flushCaches(ctx)).resolves.toEqual([]);

    expect(ctx.inputRealtimeCache).toHaveLength(1);
  });

  it('test_flush_artifact_creation', async () => {
    const artifactService = new RecordingArtifactService(456);
    const sessionService = new InMemorySessionService();
    const appendEvent = vi.spyOn(sessionService, 'appendEvent');
    const ctx = createTestContext({artifactService, sessionService});

    const testData = toBase64('specific_test_audio_data');
    manager.cacheAudio(ctx, {data: testData, mimeType: 'audio/pcm'}, 'input');

    const events = await manager.flushCaches(ctx);

    expect(artifactService.saved).toHaveLength(1);
    expect(artifactService.saved[0].artifact.inlineData?.data).toBe(testData);
    expect(artifactService.saved[0].artifact.inlineData?.mimeType).toBe(
      'audio/pcm',
    );

    expect(events[0].content?.parts?.[0].fileData?.fileUri).toBe(
      `artifact://test-app/test-user/test-session/_adk_live/` +
        `${artifactService.saved[0].filename}#456`,
    );

    // The manager returns events; appending them is the caller's decision.
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('test_get_cache_stats_empty', () => {
    const ctx = new InvocationContext({
      invocationId: 'stats-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager(),
    });

    expect(manager.getCacheStats(ctx)).toEqual({
      inputChunks: 0,
      outputChunks: 0,
      inputBytes: 0,
      outputBytes: 0,
      totalChunks: 0,
      totalBytes: 0,
    });
  });

  it('test_get_cache_stats_with_data', () => {
    const ctx = createTestContext();

    // 5, 10 and 3 decoded bytes, whose base64 forms are 8, 16 and 4
    // characters long: counting the encoded string would give 24 and 4.
    manager.cacheAudio(
      ctx,
      {data: toBase64('12345'), mimeType: 'audio/pcm'},
      'input',
    );
    manager.cacheAudio(
      ctx,
      {data: toBase64('1234567890'), mimeType: 'audio/pcm'},
      'input',
    );
    manager.cacheAudio(
      ctx,
      {data: toBase64('abc'), mimeType: 'audio/wav'},
      'output',
    );

    expect(manager.getCacheStats(ctx)).toEqual({
      inputChunks: 2,
      outputChunks: 1,
      inputBytes: 15,
      outputBytes: 3,
      totalChunks: 3,
      totalBytes: 18,
    });
  });

  it('test_error_handling_in_flush', async () => {
    const artifactService = new RecordingArtifactService();
    artifactService.failure = new Error('Artifact service error');
    const ctx = createTestContext({artifactService});

    manager.cacheAudio(
      ctx,
      {data: toBase64('test_data'), mimeType: 'audio/pcm'},
      'input',
    );

    await expect(manager.flushCaches(ctx)).resolves.toEqual([]);

    expect(ctx.inputRealtimeCache).toHaveLength(1);
  });

  it('test_filename_uses_first_chunk_timestamp', async () => {
    const artifactService = new RecordingArtifactService(789);
    const ctx = createTestContext({artifactService});

    // Epoch milliseconds, not the seconds adk-python stores: adk-js event
    // timestamps are milliseconds, and the filename carries them unconverted.
    const firstTimestamp = 1234567890123;
    const secondTimestamp = 1234567891456;

    ctx.inputRealtimeCache = [
      {
        role: 'user',
        data: {data: toBase64('first_chunk'), mimeType: 'audio/pcm'},
        timestamp: firstTimestamp,
      },
      {
        role: 'user',
        data: {data: toBase64('second_chunk'), mimeType: 'audio/pcm'},
        timestamp: secondTimestamp,
      },
    ];

    await manager.flushCaches(ctx);

    expect(artifactService.saved).toHaveLength(1);
    expect(artifactService.saved[0].filename).toBe(
      'adk_live_audio_storage_input_audio_1234567890123.pcm',
    );
  });

  it('test_flush_event_author_for_user_audio', async () => {
    const artifactService = new RecordingArtifactService();
    const ctx = createTestContext({artifactService});

    manager.cacheAudio(
      ctx,
      {data: toBase64('user_audio_data'), mimeType: 'audio/pcm'},
      'input',
    );

    const events = await manager.flushCaches(ctx, {
      flushUserAudio: true,
      flushModelAudio: false,
    });

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('user');
    expect(events[0].content?.role).toBe('user');
  });

  it('test_flush_event_author_for_model_audio', async () => {
    const artifactService = new RecordingArtifactService();
    const ctx = createTestContext({
      artifactService,
      agentName: 'my_test_agent',
    });

    manager.cacheAudio(
      ctx,
      {data: toBase64('model_audio_data'), mimeType: 'audio/wav'},
      'output',
    );

    const events = await manager.flushCaches(ctx, {
      flushUserAudio: false,
      flushModelAudio: true,
    });

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('my_test_agent');
    expect(events[0].content?.role).toBe('model');
  });
});
