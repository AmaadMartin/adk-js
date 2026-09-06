/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour the adk-python reference tests cannot cover, because a
 * `@google/genai` blob carries base64 text where a Python blob carries bytes.
 */

import {
  AudioCacheManager,
  AudioCacheType,
  InMemoryArtifactService,
  InputValidationError,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';

import {
  RecordingArtifactService,
  createTestContext,
  fromBase64,
  toBase64,
} from './audio_cache_manager_test_utils.js';

/**
 * Widens a string to the cache type, to reach the runtime guard that a
 * JavaScript caller (which has no compile-time union) can still trip.
 */
function asCacheType(value: string): AudioCacheType {
  return value as AudioCacheType;
}

describe('AudioCacheManager audio encoding', () => {
  const manager = new AudioCacheManager();

  it('concatenates chunks as bytes, so base64 padding never lands mid-payload', async () => {
    const artifactService = new RecordingArtifactService();
    const ctx = createTestContext({artifactService});

    // Decoded lengths 1, 2 and 4: every base64 padding case appears.
    const chunks = [
      Uint8Array.from([1]),
      Uint8Array.from([2, 3]),
      Uint8Array.from([4, 5, 6, 7]),
    ];
    for (const chunk of chunks) {
      manager.cacheAudio(
        ctx,
        {data: toBase64(chunk), mimeType: 'audio/pcm'},
        'input',
      );
    }

    await manager.flushCaches(ctx);

    const saved = artifactService.saved[0].artifact.inlineData?.data;
    expect(saved).toBeDefined();
    expect(Array.from(fromBase64(saved!))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('preserves bytes that are not valid UTF-8', async () => {
    const artifactService = new RecordingArtifactService();
    const ctx = createTestContext({artifactService});

    const payload = Uint8Array.from([0x80, 0xff, 0x00, 0xfe]);
    manager.cacheAudio(
      ctx,
      {data: toBase64(payload), mimeType: 'audio/pcm'},
      'input',
    );

    await manager.flushCaches(ctx);

    const saved = artifactService.saved[0].artifact.inlineData?.data;
    expect(saved).toBeDefined();
    expect(Array.from(fromBase64(saved!))).toEqual([0x80, 0xff, 0x00, 0xfe]);
  });

  it('treats a chunk with no data as empty rather than failing the flush', async () => {
    const artifactService = new RecordingArtifactService();
    const ctx = createTestContext({artifactService});

    ctx.inputRealtimeCache = [
      {
        role: 'user',
        data: {data: toBase64(Uint8Array.from([9])), mimeType: 'audio/pcm'},
        timestamp: 1000,
      },
      {role: 'user', data: {mimeType: 'audio/pcm'}, timestamp: 2000},
    ];

    await manager.flushCaches(ctx);

    const saved = artifactService.saved[0].artifact.inlineData?.data;
    expect(saved).toBeDefined();
    expect(Array.from(fromBase64(saved!))).toEqual([9]);
  });

  it('takes the mime type from the first entry', async () => {
    const artifactService = new RecordingArtifactService();
    const ctx = createTestContext({artifactService});

    manager.cacheAudio(
      ctx,
      {data: toBase64('one'), mimeType: 'audio/wav'},
      'input',
    );
    manager.cacheAudio(
      ctx,
      {data: toBase64('two'), mimeType: 'audio/l16'},
      'input',
    );

    await manager.flushCaches(ctx);

    expect(artifactService.saved[0].artifact.inlineData?.mimeType).toBe(
      'audio/wav',
    );
    expect(artifactService.saved[0].filename).toMatch(/\.wav$/);
  });

  it('falls back to audio/pcm when the first entry carries no mime type', async () => {
    const artifactService = new RecordingArtifactService();
    const ctx = createTestContext({artifactService});

    manager.cacheAudio(ctx, {data: toBase64('one')}, 'input');

    await manager.flushCaches(ctx);

    expect(artifactService.saved[0].artifact.inlineData?.mimeType).toBe(
      'audio/pcm',
    );
    expect(artifactService.saved[0].filename).toMatch(/\.pcm$/);
  });

  it('rejects a cache type that is neither input nor output', () => {
    const ctx = createTestContext();

    expect(() =>
      manager.cacheAudio(
        ctx,
        {data: toBase64('one'), mimeType: 'audio/pcm'},
        asCacheType('sideways'),
      ),
    ).toThrowError(
      new InputValidationError("cacheType must be either 'input' or 'output'"),
    );

    expect(ctx.inputRealtimeCache).toBeUndefined();
    expect(ctx.outputRealtimeCache).toBeUndefined();
  });

  it('flushes both directions when called with no options', async () => {
    const artifactService = new RecordingArtifactService();
    const ctx = createTestContext({artifactService});

    manager.cacheAudio(
      ctx,
      {data: toBase64('in'), mimeType: 'audio/pcm'},
      'input',
    );
    manager.cacheAudio(
      ctx,
      {data: toBase64('out'), mimeType: 'audio/pcm'},
      'output',
    );

    const events = await manager.flushCaches(ctx);

    expect(events.map((event) => event.author)).toEqual(['user', 'test_agent']);
  });

  it('keeps model audio when the invocation has no agent to author its event', async () => {
    const artifactService = new RecordingArtifactService();
    const ctx = new InvocationContext({
      invocationId: 'no-agent-invocation',
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager(),
      artifactService,
    });

    manager.cacheAudio(
      ctx,
      {data: toBase64('model'), mimeType: 'audio/pcm'},
      'output',
    );

    // adk-python's broad `except` covers `require_agent_name` too, so the
    // missing agent costs the turn's audio instead of the live session.
    await expect(manager.flushCaches(ctx)).resolves.toEqual([]);
    expect(ctx.outputRealtimeCache).toHaveLength(1);
  });

  it('round-trips audio through a real artifact service', async () => {
    const artifactService = new ScopedArtifactService(
      new InMemoryArtifactService(),
      'test-app',
      'test-user',
      'test-session',
    );
    const ctx = new InvocationContext({
      invocationId: 'real-invocation',
      agent: new LlmAgent({name: 'test_agent'}),
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
      }),
      pluginManager: new PluginManager(),
      artifactService,
    });

    const first = Uint8Array.from([0x00, 0x01, 0x80]);
    const second = Uint8Array.from([0xff, 0x7f]);
    manager.cacheAudio(
      ctx,
      {data: toBase64(first), mimeType: 'audio/pcm'},
      'input',
    );
    manager.cacheAudio(
      ctx,
      {data: toBase64(second), mimeType: 'audio/pcm'},
      'input',
    );

    const [event] = await manager.flushCaches(ctx);

    const keys = await artifactService.listArtifactKeys();
    expect(keys).toHaveLength(1);
    expect(event.content?.parts?.[0].fileData?.fileUri).toBe(
      `artifact://test-app/test-user/test-session/_adk_live/${keys[0]}#0`,
    );

    const loaded = await artifactService.loadArtifact({filename: keys[0]});
    const loadedData = loaded?.inlineData?.data;
    expect(loadedData).toBeDefined();
    expect(Array.from(fromBase64(loadedData!))).toEqual([
      0x00, 0x01, 0x80, 0xff, 0x7f,
    ]);
  });
});
